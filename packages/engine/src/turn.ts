/**
 * Turn：一个回合的唯一入口。顺序是固定的：
 * accepted → (modules 算数) → (llm 说话，可跳过) → arbiter 裁决 → patch → commit
 *
 * 这里没有任何玩法知识：它不知道"体力"、"图书馆"，只认 op 原语与 Module 契约。
 * 所以加玩法永远不需要改这个文件。
 */
import type {
  ActorId,
  ErrorCode,
  Envelope,
  LlmPort,
  ModuleContext,
  Modules,
  Proposal,
  Registry,
  RoomId,
  Turn,
  TurnEvent,
  TurnRequest,
  Usage,
  WorldState,
} from "../../shared/src/index.ts";
import type { EventLog } from "./store.ts";
import type { DefaultArbiter } from "./arbiter.ts";
import type { InMemoryMemory } from "./memory.ts";

export interface TurnDeps {
  store: EventLog;
  arbiter: DefaultArbiter;
  registry: Registry;
  modules: Modules;
  memory: InMemoryMemory;
  llm: LlmPort;
  /** 组装提示词；默认实现见 turn.prompt */
  buildPrompt?: (state: WorldState, actorId: ActorId, input: string) => string;
}

interface TurnJson {
  narrative?: string;
  dialogue?: string;
  proposals?: Proposal[];
}

export class DefaultTurn implements Turn {
  private readonly deps: TurnDeps;
  /** clientTurnId 幂等缓存：重复提交只重放，不再花一次 LLM 的钱 */
  private readonly seen = new Map<string, TurnEvent[]>();

  constructor(deps: TurnDeps) {
    this.deps = deps;
  }

  async *run(req: TurnRequest): AsyncIterable<TurnEvent> {
    const cached = this.seen.get(req.clientTurnId);
    if (cached) {
      for (const ev of cached) yield ev;
      return;
    }
    const events: TurnEvent[] = [];
    const emit = (ev: TurnEvent): TurnEvent => {
      events.push(ev);
      return ev;
    };

    const turnId = `turn_${req.clientTurnId}`;
    const seqNow = this.deps.store.seq(req.roomId);

    if (req.options?.expectedSeq !== undefined && req.options.expectedSeq !== seqNow) {
      yield emit({ type: "turn.rejected", code: "E_SEQ_GAP", message: `期望 seq ${req.options.expectedSeq}，实际 ${seqNow}`, retryable: false });
      return;
    }

    yield emit({ type: "turn.accepted", turnId });

    let usage: Usage | undefined;
    const proposals: Proposal[] = [];
    try {
      const state = await this.deps.store.snapshot(req.roomId);
      const ctx = this.makeContext(req, state);
      const modOut = await this.deps.modules.dispatchIntent(ctx);
      proposals.push(...modOut.proposals);

      if (!req.options?.skipLLM) {
        {
          // 真实模型：流式只为了让首字早点出现；mock 一次性返回
          const res = await this.deps.llm.chat({
            json: true,
            messages: [
              { role: "system", content: this.prompt(state, req.actorId, req.input) },
              { role: "user", content: req.input },
            ],
            maxTokens: 900,
          });
          usage = res.usage;
          const parsed = parseTurn(res.raw);
          if (!parsed) {
            yield emit({ type: "turn.error", code: "E_LLM_FORMAT", message: "模型输出不是合法 JSON", retryable: true });
            return;
          }
          if (parsed.proposals?.length) proposals.push(...parsed.proposals);
          const text = [parsed.narrative, parsed.dialogue].filter(Boolean).join("\n");
          if (text) yield emit({ type: "turn.delta", field: "narrative", text });
        }
      }

      const cause = this.cause(req, seqNow);
      const applied = await this.deps.arbiter.apply(req.roomId, proposals, cause);
      const after = await this.deps.store.snapshot(req.roomId);
      if (applied.events.length > 0) {
        yield emit({ type: "turn.patch", state: after, ops: applied.applied });
      }
      if (applied.rejected.length > 0 && !applied.ok) {
        yield emit({ type: "turn.error", code: "E_PROPOSAL_REJECTED", message: JSON.stringify(applied.rejected).slice(0, 300), retryable: false });
        return;
      }
      const seq = this.deps.store.seq(req.roomId);
      const commit: TurnEvent = { type: "turn.commit", turnId, seq, usage };
      yield emit(commit);
      this.seen.set(req.clientTurnId, events);
    } catch (e) {
      // LLM 网关抛的 LlmError 自带 ErrorCode；其余一律 E_UPSTREAM
      yield emit({ type: "turn.error", code: codeOf(e), message: errMessage(e), retryable: true });
    }
  }

  private cause(req: TurnRequest, seq: number): Envelope {
    return { v: 1, id: `evt_${req.clientTurnId}`, roomId: req.roomId, seq: seq + 1, ts: Date.now(), actorId: req.actorId, type: "turn.input", payload: { input: req.input } };
  }

  private makeContext(req: TurnRequest, state: WorldState): ModuleContext {
    const e = (id: string) => state.entities[id];
    return {
      roomId: req.roomId,
      actorId: req.actorId,
      input: req.input,
      state,
      registry: this.deps.registry,
      clock: state.clock,
      query: {
        entity: (id) => e(id),
        attr: (entityId, key) => e(entityId)?.attrs[key],
        present: () => [...state.room.scene.presentIds],
        links: (kind, from) =>
          state.links.filter((l) => (!kind || l.kind === kind) && (!from || l.from === from)),
      },
      llm: this.deps.llm,
      log: (msg) => (process.env.GALGAME_DEBUG ? console.error(`[module] ${msg}`) : undefined),
    };
  }

  private prompt(state: WorldState, actorId: ActorId, input: string): string {
    const me = state.entities[actorId];
    const where = state.entities[state.room.scene.locId];
    return [
      "你是校园文字冒险游戏的叙事者。用第二人称、中文、克制的白描，不复述玩家原话。",
      `当前地点：${where?.name ?? "未知"}；第 ${state.clock.day} 天 ${state.clock.phase}。`,
      `玩家：${me?.name ?? actorId}。`,
      "只输出 JSON，字段：narrative(环境与动作)、dialogue(NPC 台词，可为空)、proposals(状态变更提议，可为空数组)。",
      '示例：{"narrative":"…","dialogue":"…","proposals":[{"op":"attr.delta","args":{"entityId":"plr_self","key":"stamina","delta":-2},"reason":"走了半小时"}]}',
      "禁止编造未声明的属性键；只能使用 registry 中存在的属性。",
      `玩家输入：${input}`,
    ].join("\n");
  }
}

function codeOf(e: unknown): ErrorCode {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && c.startsWith("E_")) return c as ErrorCode;
  }
  // 契约错误码是闭集，没有"未知内部错误"；这类异常按引擎故障上报
  return "E_MODULE_FAULT";
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseTurn(raw: string): TurnJson | null {
  if (!raw || raw.trim() === "") return null;
  const body = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as TurnJson;
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}
