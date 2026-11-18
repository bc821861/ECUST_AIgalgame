/**
 * 群聊会话（dev/v2）：与 v1 DialogueHost 并列的新入口，不改 v1 任何签名。
 *
 * 职责边界：本文件只做编排——投递、独立调度、审核、把结果变成 Proposal 交 Arbiter。
 * 世界状态的所有变更仍只有一条路（I1）；本文件不碰 store.append、不碰文件。
 */
import type {
  ActorId,
  ApplyResult,
  ConversationEvent,
  ConversationSessionV2,
  ConversationSpecV2,
  ConversationTurnInput,
  ConversationTurnV2,
  Id,
  Proposal,
  Utterance,
} from "../../../shared/src/index.ts";
import type { EventLog } from "../store.ts";
import type { DefaultArbiter } from "../arbiter.ts";
import type { EventSourcedMemory } from "../memory.ts";
import type { Registry, UtteranceModeDef, ConversationPolicy } from "../../../shared/src/index.ts";
import { deliver, validateUtterance } from "./delivery.ts";
import { shouldWake, type SceneManager } from "./scene.ts";
import type { NpcAgent } from "./npc-agent.ts";
import type { ConversationAudit } from "./audit.ts";
import { mentalFields, mentalProposal, memoryProposals, utteranceFields } from "./conversation.helpers.ts";

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

/** flush 失败：apply 已改内存，但落盘未成功 —— 必须可重试，且不能写进幂等缓存 */
class StoreFlushError extends Error {
  constructor(
    readonly roomId: string,
    readonly applied: ApplyResult,
  ) {
    super("store.flush failed");
  }
}

interface PendingFlush {
  roomId: string;
  s: ConversationSessionV2;
  applied: ApplyResult;
  out: ConversationEvent[];
}

const MAX_SEEN = 256;

export class ConversationHostV2 implements ConversationTurnV2 {
  private readonly sessions = new Map<Id, ConversationSessionV2>();
  private readonly seen = new Map<string, ConversationEvent[]>();
  private readonly pendingFlush = new Map<string, PendingFlush>();
  private nextId = 0;

  constructor(private readonly deps: ConversationDeps) {}

  /** 仅用于测试/观测：幂等缓存条数（有界，MAX_SEEN） */
  get idempotencySize(): number {
    return this.seen.size;
  }

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

  /** listenTimeoutMs 到期恢复 speaking。供 server 定时调用；返回被恢复的会话 id。 */
  resumeExpired(now = this.deps.now?.() ?? Date.now()): Id[] {
    const out: Id[] = [];
    const timeout = this.deps.policy.listenTimeoutMs;
    for (const s of this.sessions.values()) {
      if (s.phase === "listening" && s.listenSince !== undefined && now - s.listenSince >= timeout) {
        s.phase = "speaking";
        s.listenSince = undefined;
        out.push(s.id);
      }
    }
    return out;
  }

  async *run(sessionId: Id, input: ConversationTurnInput): AsyncIterable<ConversationEvent> {
    const actorId = input.utterance?.speaker ?? input.interject ?? "sys";
    const key = JSON.stringify([sessionId, actorId, input.clientTurnId]);
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

    // 落盘重试：apply 已完成、记忆已 ingest，这次只重试 flush，绝不重复发 Proposal
    const pending = this.pendingFlush.get(key);
    if (pending) {
      try {
        await this.deps.store.flush(pending.roomId);
      } catch {
        yield { type: "conversation.error", sessionId, code: "E_STORE_FAULT", message: "落盘仍不可用，可安全重试", retryable: true };
        return;
      }
      const done = await this.commitWithState(pending.s, pending.applied);
      const all = [...pending.out, done];
      this.remember(key, all);
      this.pendingFlush.delete(key);
      for (const ev of all) yield ev;
      return;
    }

    // 插话超时自动恢复（不依赖调用方记得发 tick，也能在下一个请求里自愈）
    const now = this.deps.now?.() ?? Date.now();
    if (s.phase === "listening" && s.listenSince !== undefined && now - s.listenSince >= this.deps.policy.listenTimeoutMs) {
      s.phase = "speaking";
      s.listenSince = undefined;
    }

    const out: ConversationEvent[] = [];
    try {
      await this.step(s, input, out, now);
    } catch (e) {
      if (e instanceof StoreFlushError) {
        this.pendingFlush.set(key, { roomId: e.roomId, s, applied: e.applied, out });
        out.push({ type: "conversation.error", sessionId, code: "E_STORE_FAULT", message: e.message, retryable: true });
      } else {
        out.push({
          type: "conversation.error",
          sessionId,
          code: "E_MODULE_FAULT",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!out.some((e) => e.type === "conversation.error" && e.retryable)) this.remember(key, out);
    for (const ev of out) yield ev;
  }

  private remember(key: string, events: ConversationEvent[]): void {
    this.seen.set(key, events);
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private async step(s: ConversationSessionV2, input: ConversationTurnInput, out: ConversationEvent[], now: number): Promise<void> {
    const { store, arbiter, memory, modes, policy } = this.deps;
    const state = await store.snapshot(s.roomId);
    const present = state.room.scene.presentIds ?? [];
    const nameOf = (id: ActorId): string => state.entities[id]?.name ?? id;
    const seq = await store.load(s.roomId);
    const playerId = present.find((id) => id.startsWith("plr_"));

    // ① 插话：切换 phase；本请求不触发 NPC 发言（等玩家真正说话）
    if (input.interject) {
      s.phase = "listening";
      s.listenSince = now;
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

    // ③ 场景唤醒：显式 @全体/@多人，或换地点（开关从策略数据读）
    const lastLoc = [...s.sceneBeats].reverse().find((b) => b.locId)?.locId;
    const wake = shouldWake({
      utterance: playerUtterance,
      locationChanged: !!lastLoc && lastLoc !== state.room.scene.locId,
      wakeOnMultiTarget: this.deps.wakeOnMultiTarget ?? policy.wakeOnMultiTarget,
      wakeOnLocationChange: this.deps.wakeOnLocationChange ?? policy.wakeOnLocationChange,
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
      proposals.push(...memoryProposals(playerUtterance, s.roomId, modes));
      s.npcSpeechStreak = 0;
      s.listenSince = undefined;
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
        proposals.push(...memoryProposals(u, s.roomId, modes));
      } else if (d.decision.kind === "think") {
        out.push({ type: "conversation.mental", actorId: d.npcId, mental: d.decision.mental });
        proposals.push(mentalProposal(d.npcId, d.decision.mental));
      }
    }

    // ⑦ 玩家发言后若 phase=listening，恢复 speaking（NPC 本轮只听不说）
    if (listening && playerUtterance) {
      s.phase = "speaking";
      s.listenSince = undefined;
      out.push({ type: "conversation.phase", sessionId: s.id, phase: "speaking" });
    }

    // ⑧ 唯一写入口：整批 Proposal 一次裁决（atomic）
    if (proposals.length) {
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
      // 写后的事件必须回喂记忆索引，否则"写了没人读"（PR#4 P0-1 的教训）
      for (const ev of applied.events) memory.ingest(ev);
      try {
        await store.flush(s.roomId);
      } catch (e) {
        throw new StoreFlushError(s.roomId, applied);
      }
      const done = await this.commitWithState(s, applied);
      out.push(done);
    } else {
      s.turn += 1;
      if (s.turn >= s.maxTurns) s.status = "closed";
    }
  }

  private async commitWithState(s: ConversationSessionV2, applied: ApplyResult): Promise<ConversationEvent> {
    const turn = ++s.turn;
    if (turn >= s.maxTurns) s.status = "closed";
    return {
      type: "conversation.committed",
      sessionId: s.id,
      turn,
      proposals: applied.applied,
      state: await this.deps.store.snapshot(s.roomId),
    };
  }
}
