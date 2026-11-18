/**
 * 单轮群聊结算（dev/v2）：从宿主拆出，保持 conversation.ts 在 300 行以内。
 * 这里只做编排：投递 → 并行 NPC 决策 → 审核 → 一次性 Proposal；不直接写状态。
 */
import type { ActorId, ApplyResult, ConversationEvent, ConversationSessionV2, ConversationTurnInput, Proposal, Utterance } from "../../../shared/src/index.ts";
import { deliver, validateUtterance } from "./delivery.ts";
import { shouldWake, type SceneManager } from "./scene.ts";
import { mentalFields, mentalProposal, memoryProposals, utteranceFields } from "./conversation.helpers.ts";
import type { ConversationDeps } from "./conversation.ts";

export class StoreFlushError extends Error {
  constructor(
    readonly roomId: string,
    readonly applied: ApplyResult,
  ) {
    super("store.flush failed");
  }
}

export async function runStep(
  deps: ConversationDeps,
  s: ConversationSessionV2,
  input: ConversationTurnInput,
  out: ConversationEvent[],
  now: number,
  commit: (s: ConversationSessionV2, applied: ApplyResult) => Promise<ConversationEvent>,
): Promise<void> {
  const { store, arbiter, memory, modes, policy } = deps;
  const state = await store.snapshot(s.roomId);
  const present = state.room.scene.presentIds ?? [];
  const nameOf = (id: ActorId): string => state.entities[id]?.name ?? id;
  const kindOf = (id: ActorId) => state.entities[id]?.kind;
  const playerId = present.find((id) => kindOf(id) === "plr");
  const seq = await store.load(s.roomId);

  // ① 插话：切换 phase；本请求不触发 NPC 发言（等玩家真正说话）
  if (input.interject) {
    s.phase = "listening";
    s.listenSince = now;
    out.push({ type: "conversation.phase", sessionId: s.id, phase: "listening" });
    return;
  }

  // ② 玩家发言：校验 + 审核（这两步在投递之前，坏话绝不能被别人看见）
  let playerUtterance: Utterance | undefined;
  let playerDeliveries: ConversationEvent[] = [];
  if (input.utterance) {
    const v = validateUtterance(input.utterance, modes, policy, present);
    if (!v.ok || !v.value) {
      out.push({ type: "conversation.error", sessionId: s.id, code: v.code ?? "E_SCHEMA_INVALID", message: v.message ?? "发言无效" });
      return;
    }
    playerUtterance = v.value;
    const review = await deps.audit.review({
      roomId: s.roomId,
      actorId: playerUtterance.speaker,
      playerInput: playerUtterance.content ?? playerUtterance.action ?? "",
      fields: utteranceFields(playerUtterance),
    });
    if (review.kind === "blocked") {
      const p = await deps.audit.punishPlayer({
        roomId: s.roomId,
        actorId: playerUtterance.speaker,
        clientTurnId: input.clientTurnId,
        verdict: review.verdict,
        state,
        seq,
      });
      out.push({ type: "conversation.notice", text: p.text, facts: p.facts });
      return;
    }
    if (review.kind === "unavailable") {
      out.push({ type: "conversation.error", sessionId: s.id, code: "E_CONTENT_BLOCKED", message: "审核器不可用，本轮不发布" });
      return;
    }
    playerDeliveries = deliver(playerUtterance, { recipients: present, modes, noticeFor: nameOf }).map((delivery) => ({
      type: "conversation.utterance" as const,
      delivery,
    }));
  }

  // ③ 换地点/多目标唤醒：用会话记录的 lastLocId（SceneBeat 可能尚未写过 locId）
  const locationChanged = !!s.lastLocId && s.lastLocId !== state.room.scene.locId;
  const wake = shouldWake({
    utterance: playerUtterance,
    locationChanged,
    wakeOnMultiTarget: deps.wakeOnMultiTarget ?? policy.wakeOnMultiTarget,
    wakeOnLocationChange: deps.wakeOnLocationChange ?? policy.wakeOnLocationChange,
  });
  let sceneEvents: ConversationEvent[] = [];
  if (wake) {
    const recent = playerDeliveries.flatMap((e) => (e.type === "conversation.utterance" ? [e.delivery.content ?? e.delivery.action ?? ""] : []));
    const beat = await deps.scene.wake(s.id, s.roomId, wake, recent, state.room.scene.locId);
    s.sceneBeats.push(beat);
    s.lastLocId = state.room.scene.locId;
    sceneEvents = [{ type: "conversation.scene", beat }];
  } else {
    s.lastLocId = state.room.scene.locId;
  }

  // ④ 投递：scene order="before"（换地点）先放场景，否则先放玩家发言
  out.push(...(sceneEvents[0]?.type === "conversation.scene" && sceneEvents[0].beat.order === "before" ? [...sceneEvents, ...playerDeliveries] : [...playerDeliveries, ...sceneEvents]));
  const proposals: Proposal[] = [];
  if (playerUtterance) {
    proposals.push(...memoryProposals(playerUtterance, s.roomId, modes));
    s.npcSpeechStreak = 0;
    s.listenSince = undefined;
  } else if (playerId) {
    s.npcSpeechStreak += 1;
  }

  // ⑤ 每个在场 NPC 各自一次 LLM；玩家不在场时受 autonomousWhenPlayerAbsent 控制
  const autonomous = policy.autonomousWhenPlayerAbsent || !!playerId;
  const npcIds = autonomous
    ? present.filter((id) => kindOf(id) === "npc" && id !== playerUtterance?.speaker)
    : [];
  const hardCap = !!playerId && !playerUtterance && policy.npcHardCap > 0 && s.npcSpeechStreak >= policy.npcHardCap;
  const listening = s.phase === "listening";
  const decisions = await Promise.all(
    npcIds.map(async (npcId) => {
      const hits = playerUtterance ? deliver(playerUtterance, { recipients: [npcId], modes, noticeFor: nameOf }) : [];
      const own = await memory.recall({ roomId: s.roomId, ownerId: npcId, budgetTokens: 300, nowTurn: state.clock.tick });
      const memoryText = own.slice(0, 4).map((h) => `- ${h.record.content}`).join("\n");
      const r = await deps.npc.decide({
        npcId,
        npcName: nameOf(npcId),
        turnKey: s.turn,
        state,
        deliveries: hits,
        sceneText: deps.scene.render(s.id),
        memoryText,
        streak: s.npcSpeechStreak,
        playerPresent: !!playerId,
        hardCapReached: hardCap,
        listening,
      });
      return { npcId, ...r };
    }),
  );

  // ⑥ 扩面审核：不合规只丢这一位；心理活动含 plan
  for (const d of decisions) {
    const fields = d.decision.kind === "speak" ? utteranceFields(d.decision.utterance) : d.decision.kind === "think" ? mentalFields(d.decision.mental) : [];
    if (fields.length === 0) continue;
    const review = await deps.audit.review({ roomId: s.roomId, actorId: d.npcId, playerInput: playerUtterance?.content ?? "", fields });
    if (review.kind !== "ok") continue;
    if (d.decision.kind === "speak") {
      const u = d.decision.utterance;
      for (const delivery of deliver(u, { recipients: present, modes, noticeFor: nameOf })) {
        out.push({ type: "conversation.utterance", delivery });
      }
      proposals.push(...memoryProposals(u, s.roomId, modes));
    } else if (d.decision.kind === "think") {
      out.push({ type: "conversation.mental", actorId: d.npcId, mental: d.decision.mental });
      proposals.push(mentalProposal(d.npcId, d.decision.mental));
    }
  }

  // ⑦ 玩家发言后若 phase=listening，恢复 speaking
  if (listening && playerUtterance) {
    s.phase = "speaking";
    s.listenSince = undefined;
    out.push({ type: "conversation.phase", sessionId: s.id, phase: "speaking" });
  }

  // ⑧ 唯一写入口：整批 Proposal 一次裁决；无提案也要发 committed 让对端收口
  const cause = {
    v: 1 as const,
    id: `evt_conv_${input.clientTurnId}`,
    roomId: s.roomId,
    seq: seq + 1,
    ts: now,
    actorId: playerUtterance?.speaker ?? "sys",
    type: "dialogue.speak",
    payload: {},
  };
  if (proposals.length) {
    const applied = await arbiter.apply(s.roomId, proposals, cause, { expectedSeq: seq });
    if (!applied.ok) {
      out.push({
        type: "conversation.error",
        sessionId: s.id,
        code: applied.error?.code ?? applied.rejected[0]?.code ?? "E_MODULE_FAULT",
        message: applied.error?.message ?? "本轮记忆写入被拒，发言未落库",
      });
      return;
    }
    for (const ev of applied.events) memory.ingest(ev); // PR#4 P0-1：写了必须能读到
    try {
      await store.flush(s.roomId);
    } catch {
      throw new StoreFlushError(s.roomId, applied);
    }
    out.push(await commit(s, applied));
  } else {
    out.push(await commit(s, { ok: true, mode: "atomic", seq: seq + 1, applied: [], rejected: [], events: [] }));
  }
}
