/**
 * 群聊会话（dev/v2）：与 v1 DialogueHost 并列的新入口，不改 v1 任何签名。
 *
 * 职责边界：本文件只做编排——投递、独立调度、审核、把结果变成 Proposal 交 Arbiter。
 * 世界状态的所有变更仍只有一条路（I1）；本文件不碰 store.append、不碰文件。
 */
import type {
  ActorId,
  ConversationEvent,
  ConversationSessionV2,
  ConversationSpecV2,
  ConversationTurnInput,
  ConversationTurnV2,
  Id,
  Proposal,
  RoomId,
  Utterance,
  WorldState,
} from "../../../shared/src/index.ts";
import type { EventLog } from "../store.ts";
import type { DefaultArbiter } from "../arbiter.ts";
import type { EventSourcedMemory } from "../memory.ts";
import type { Registry } from "../../../shared/src/index.ts";
import type { UtteranceModeDef, ConversationPolicy } from "../../../shared/src/index.ts";
import { deliver, validateUtterance } from "./delivery.ts";
import { shouldWake, type SceneManager } from "./scene.ts";
import type { NpcAgent } from "./npc-agent.ts";
import type { ConversationAudit } from "./audit.ts";

export interface ConversationDeps {
  store: EventLog;
  arbiter: DefaultArbiter;
  registry: Registry;
  memory: EventSourcedMemory;
  modes: Map<string, UtteranceModeDef>;
  policy: ConversationPolicy;
  scene: SceneManager;
  npc: NpcAgent;
  audit: ConversationAudit;
  wakeOnMultiTarget?: boolean;
  wakeOnLocationChange?: boolean;
  now?: () => number;
}

export class ConversationHostV2 implements ConversationTurnV2 {
  private readonly sessions = new Map<Id, ConversationSessionV2>();
  /** clientTurnId 幂等（进程内，同 v1 的已知边界） */
  private readonly seen = new Map<string, ConversationEvent[]>();
  private nextId = 0;

  constructor(private readonly deps: ConversationDeps) {}

  async open(spec: ConversationSpecV2): Promise<ConversationSessionV2> {
    const session: ConversationSessionV2 = {
      id: `conv_${++this.nextId}`,
      roomId: spec.roomId,
      participants: [...spec.participants],
      phase: "speaking",
      turn: 0,
      maxTurns: spec.maxTurns ?? this.deps.policy.maxTurns,
      status: "open",
      queue: [],
      injected: [],
      sceneBeats: [],
      npcSpeechStreak: 0,
      visibility: spec.visibility ?? "scene",
    };
    this.sessions.set(session.id, session);
    const state = await this.deps.store.snapshot(spec.roomId);
    const locId = state.room.scene.locId;
    session.sceneBeats.push(
      await this.deps.scene.open(session.id, spec.roomId, locId ? state.entities[locId]?.name : undefined, spec.participants),
    );
    return session;
  }

  get(sessionId: Id): ConversationSessionV2 | undefined {
    return this.sessions.get(sessionId);
  }

  async *run(sessionId: Id, input: ConversationTurnInput): AsyncIterable<ConversationEvent> {
    const key = JSON.stringify([sessionId, input.clientTurnId]);
    const cached = this.seen.get(key);
    if (cached) {
      for (const ev of cached) yield ev;
      return;
    }

    const s = this.sessions.get(sessionId);
    if (!s || s.status === "closed") {
      yield { type: "conversation.error", sessionId, code: "E_DIALOGUE_NOT_FOUND", message: "会话不存在或已关闭" };
      return;
    }
    const out: ConversationEvent[] = [];
    try {
      await this.step(s, input, out);
    } catch (e) {
      out.push({
        type: "conversation.error",
        sessionId,
        code: "E_MODULE_FAULT",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    this.seen.set(key, out);
    for (const ev of out) yield ev;
  }

  private async step(s: ConversationSessionV2, input: ConversationTurnInput, out: ConversationEvent[]): Promise<void> {
    const { store, arbiter, registry, memory, modes, policy } = this.deps;
    const state = await store.snapshot(s.roomId);
    const present = state.room.scene.presentIds ?? [];
    const nameOf = (id: ActorId): string => state.entities[id]?.name ?? id;
    const seq = await store.load(s.roomId);
    const playerId = present.find((id) => id.startsWith("plr_"));

    // ① 插话：切换 phase；本请求不触发 NPC 发言（等玩家真正说话）
    if (input.interject) {
      s.phase = "listening";
      out.push({ type: "conversation.phase", sessionId: s.id, phase: "listening" });
      return;
    }

    // ② 玩家发言：校验 + 审核（这两步在投递之前，坏话绝不能被别人看见）
    let playerUtterance: Utterance | undefined;
    if (input.utterance) {
      const v = validateUtterance(input.utterance, modes, policy, present);
      if (!v.ok || !v.value) {
        out.push({ type: "conversation.error", sessionId: s.id, code: v.code ?? "E_SCHEMA_INVALID", message: v.message ?? "发言无效" });
        return;
      }
      playerUtterance = v.value;
      const review = await this.deps.audit.review({
        roomId: s.roomId,
        actorId: playerUtterance.speaker,
        playerInput: playerUtterance.content ?? playerUtterance.action ?? "",
        fields: utteranceFields(playerUtterance),
      });
      if (review.kind === "blocked") {
        const p = await this.deps.audit.punishPlayer({
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
    }

    // ③ 场景唤醒：显式 @全体/@多人，或换地点
    const wake = shouldWake({
      utterance: playerUtterance,
      locationChanged: false,
      wakeOnMultiTarget: this.deps.wakeOnMultiTarget ?? true,
      wakeOnLocationChange: this.deps.wakeOnLocationChange ?? true,
    });
    if (wake) {
      const recent = out.flatMap((e) => (e.type === "conversation.utterance" ? [e.delivery.content ?? e.delivery.action ?? ""] : []));
      const beat = await this.deps.scene.wake(s.id, s.roomId, wake, recent);
      s.sceneBeats.push(beat);
      out.push({ type: "conversation.scene", beat });
    }

    // ④ 投递玩家的话：玩家自己也按同一套矩阵收（悄悄话对玩家只给神色）
    const proposals: Proposal[] = [];
    if (playerUtterance) {
      for (const d of deliver(playerUtterance, { recipients: present, modes, noticeFor: nameOf })) {
        out.push({ type: "conversation.utterance", delivery: d });
      }
      proposals.push(...memoryProposals(playerUtterance, s.roomId));
      s.npcSpeechStreak = 0;
    } else if (playerId) {
      s.npcSpeechStreak += 1;
    }

    // ⑤ 每个在场 NPC 各自一次 LLM（并行但上下文完全隔离）
    const npcIds = present.filter((id) => id.startsWith("npc_") && id !== playerUtterance?.speaker);
    const hardCap = !!playerId && !playerUtterance && policy.npcHardCap > 0 && s.npcSpeechStreak >= policy.npcHardCap;
    const listening = s.phase === "listening";
    const decisions = await Promise.all(
      npcIds.map(async (npcId) => {
        const hits = playerUtterance ? deliver(playerUtterance, { recipients: [npcId], modes, noticeFor: nameOf }) : [];
        const own = await memory.recall({ roomId: s.roomId, ownerId: npcId, budgetTokens: 300, nowTurn: state.clock.tick });
        const memoryText = own.slice(0, 4).map((h) => `- ${h.record.content}`).join("\n");
        const r = await this.deps.npc.decide({
          npcId,
          npcName: nameOf(npcId),
          state,
          deliveries: hits,
          sceneText: this.deps.scene.render(s.id),
          memoryText,
          streak: s.npcSpeechStreak,
          playerPresent: !!playerId,
          hardCapReached: hardCap,
          listening,
        });
        return { npcId, ...r };
      }),
    );

    // ⑥ 审核扩面：content/action/coverAction/notice/thought/plan
    for (const d of decisions) {
      const fields = d.decision.kind === "speak" ? utteranceFields(d.decision.utterance) : d.decision.kind === "think" ? mentalFields(d.decision.mental) : [];
      if (fields.length === 0) continue;
      const review = await this.deps.audit.review({ roomId: s.roomId, actorId: d.npcId, playerInput: playerUtterance?.content ?? "", fields });
      if (review.kind !== "ok") continue; // NPC 违规/审核故障：只丢这一位的输出，不惩罚玩家
      if (d.decision.kind === "speak") {
        const u = d.decision.utterance;
        for (const delivery of deliver(u, { recipients: present, modes, noticeFor: nameOf })) {
          out.push({ type: "conversation.utterance", delivery });
        }
        proposals.push(...memoryProposals(u, s.roomId));
      } else if (d.decision.kind === "think") {
        const m = d.decision.mental;
        out.push({ type: "conversation.mental", actorId: d.npcId, mental: m });
        proposals.push({
          op: "memory.write",
          args: {
            ownerId: d.npcId,
            content: [m.thought, m.plan ? `打算：${m.plan}` : ""].filter(Boolean).join("\n"),
            tags: ["mental", ...(m.about ?? [])],
            salience: m.salience * 20,
            visibility: "secret",
            ...(m.about?.length ? { about: m.about } : {}),
          },
          reason: "NPC 心理活动",
          by: "dialogue.think",
        });
      }
    }

    // ⑦ 玩家发言后若 phase=listening，恢复 speaking（NPC 本轮只听不说）
    if (listening && playerUtterance) {
      s.phase = "speaking";
      out.push({ type: "conversation.phase", sessionId: s.id, phase: "speaking" });
    }

    // ⑧ 唯一写入口：整批 Proposal 一次裁决（atomic）
    if (proposals.length) {
      const cause = {
        v: 1 as const,
        id: `evt_conv_${input.clientTurnId}`,
        roomId: s.roomId,
        seq: seq + 1,
        ts: this.deps.now?.() ?? Date.now(),
        actorId: playerUtterance?.speaker ?? "sys",
        type: "dialogue.speak",
        payload: {},
      };
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
      // 和 v1 turn.ts 一样：写后的事件必须回喂记忆索引，否则"写了没人读"（PR#4 P0-1 的教训）
      for (const ev of applied.events) memory.ingest(ev);
      await store.flush(s.roomId);
      out.push({
        type: "conversation.committed",
        sessionId: s.id,
        turn: ++s.turn,
        proposals: applied.applied,
        state: await store.snapshot(s.roomId),
      });
    } else {
      s.turn += 1;
    }
    if (s.turn >= s.maxTurns) s.status = "closed";
  }
}

/** 说话的四段结构 → 待审文本（标签化，审核器能看到"这是动作还是内容"） */
export function utteranceFields(u: Utterance) {
  return [
    { label: "说话目标", text: u.target ? String(u.target) : "全体" },
    { label: "说话方式", text: u.mode },
    { label: "说话内容", text: u.content ?? "" },
    { label: "说话动作", text: u.action ?? "" },
    { label: "旁观动作", text: u.coverAction ?? "" },
    { label: "附加标记", text: u.notice ?? "" },
  ];
}

function mentalFields(m: { thought: string; plan?: string }) {
  return [
    { label: "心理思考", text: m.thought },
    { label: "行动计划", text: m.plan ?? "" },
  ];
}

/** 一句话 → 可持久化的 memory.write Proposal（public/private/secret 由 mode 决定） */
function memoryProposals(u: Utterance, roomId: RoomId): Proposal[] {
  const text = u.content ? `${u.content}${u.action ? `（${u.action}）` : ""}` : u.action ?? "";
  if (!text.trim()) return [];
  const visibility: "public" | "private" | "secret" =
    u.mode === "signal" ? "secret" : u.mode === "whisper" || (u.target && u.target !== "all") ? "private" : "public";
  const args: Record<string, unknown> = {
    ownerId: u.speaker,
    content: text.slice(0, 500),
    tags: ["dialogue", u.mode],
    salience: 60,
    visibility,
  };
  if (u.target && u.target !== "all") args.about = Array.isArray(u.target) ? u.target : [u.target];
  return [{ op: "memory.write", args, reason: `群聊发言（${u.mode}）`, by: "dialogue.speak" }];
}
