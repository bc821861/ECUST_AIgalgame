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
    // 先载入再读 seq：文件存储在重启后 seq 是懒加载的（MAJOR-1）
    const seqNow = await this.deps.store.load(req.roomId);

    if (req.options?.expectedSeq !== undefined && req.options.expectedSeq !== seqNow) {
      yield emit({ type: "turn.rejected", code: "E_SEQ_GAP", message: `期望 seq ${req.options.expectedSeq}，实际 ${seqNow}`, retryable: false });
      return;
    }

    yield emit({ type: "turn.accepted", turnId });

    const cause = this.cause(req, seqNow);
    const causeForBudget = { ...cause, causedBy: turnId };
    let usage: Usage | undefined;
    const moduleProposals: Proposal[] = [];
    const llmProposals: Proposal[] = [];
    let narrative = "";

    try {
      const state = await this.deps.store.snapshot(req.roomId);
      const ctx = this.makeContext(req, state);
      const modOut = await this.deps.modules.dispatchIntent(ctx);
      moduleProposals.push(...modOut.proposals);

      if (!req.options?.skipLLM) {
        const first = await this.askLlm(req, state, usage);
        if (!first) return;
        usage = first.usage;
        llmProposals.push(...first.proposals);
        narrative = first.text;
      }

      // ① 裁决：默认 atomic —— 任何一条被拒，整批不落库
      let applied = await this.deps.arbiter.apply(req.roomId, [...moduleProposals, ...llmProposals], causeForBudget, {
        expectedSeq: seqNow,
      });

      // ② 一次修复：只有"模型给的提案"坏了才值得再问一次；模块的提案坏了属于代码 bug
      let repairError = "";
      if (!applied.ok && applied.rejected.length > 0 && moduleProposals.length === 0) {
        const badLlm = applied.rejected.every((r) => llmProposals.includes(r.proposal));
        if (badLlm) {
          const repaired = await this.repair(req, state, applied.rejected, usage);
          if (repaired && !repaired.ok) {
            repairError = repaired.error; // 修复本身失败（网络/格式）：别静默吞掉，写进最终错误
          } else if (repaired) {
            usage = repaired.usage;
            if (repaired.text) narrative = repaired.text;
            llmProposals.length = 0;
            llmProposals.push(...repaired.proposals);
            applied = await this.deps.arbiter.apply(req.roomId, [...moduleProposals, ...llmProposals], causeForBudget, {
              expectedSeq: this.deps.store.seq(req.roomId),
            });
          }
        }
      }

      // ②.5 整批层面的失败：没有"哪条 proposal 被拒"可说
      if (applied.error) {
        if (applied.error.code === "E_SEQ_GAP") {
          yield emit({ type: "turn.rejected", code: "E_SEQ_GAP", message: applied.error.message, retryable: false });
        } else {
          yield emit({ type: "turn.error", code: codeOf({ code: applied.error.code }), message: applied.error.message, retryable: true });
        }
        return;
      }

      // ③ 仍然不 ok：不提交、不叙事，把原因交回编排层
      if (!applied.ok) {
        const fromModule = applied.rejected.some((r) => moduleProposals.includes(r.proposal));
        const first = applied.rejected[0];
        yield emit({
          type: "turn.error",
          code: fromModule ? "E_MODULE_FAULT" : ((first?.code as ErrorCode) ?? "E_MODULE_FAULT"),
          message: `提案被拒（${applied.rejected.length} 条）：${applied.rejected.map((r) => `${r.code}`).join(",")}${repairError ? `；修复也失败：${repairError}` : ""}`,
          retryable: false,
        });
        return;
      }

      // ④ 叙事在裁决之后才发：先宣布成功再回滚是这个系统最不能有的 bug
      if (narrative) yield emit({ type: "turn.delta", field: "narrative", text: narrative });
      if (modOut.facts && modOut.facts.length > 0) yield emit({ type: "turn.facts", facts: modOut.facts });
      if (modOut.ui) yield emit({ type: "turn.ui", view: modOut.ui });

      const after = await this.deps.store.snapshot(req.roomId);
      if (applied.events.length > 0) {
        yield emit({ type: "turn.patch", state: after, ops: applied.applied });
      }

      // ⑤ 内存提交 ≠ 可靠存档：等落盘成功才算 commit
      try {
        await this.deps.store.flush(req.roomId);
      } catch (e) {
        yield emit({ type: "turn.error", code: "E_STORE_FAULT", message: `落盘失败：${errMessage(e)}`, retryable: true });
        return;
      }

      const seq = this.deps.store.seq(req.roomId);
      yield emit({ type: "turn.commit", turnId, seq, usage });
      this.seen.set(req.clientTurnId, events);
    } catch (e) {
      yield emit({ type: "turn.error", code: codeOf(e), message: errMessage(e), retryable: true });
    } finally {
      // 不论成功、失败还是抛异常，都释放本回合预算（否则预算表只增不减）
      this.deps.arbiter.endTurn(turnId);
    }
  }

  /** 一次模型调用；返回 undefined 表示已经发过错误事件、调用方应直接返回 */
  private async askLlm(
    req: TurnRequest,
    state: WorldState,
    _usage: Usage | undefined,
  ): Promise<{ proposals: Proposal[]; text: string; usage?: Usage } | undefined> {
    const res = await this.deps.llm.chat({
      json: true,
      messages: [
        { role: "system", content: this.prompt(state, req.actorId, req.input) },
        { role: "user", content: req.input },
      ],
      maxTokens: 900,
    });
    const parsed = parseTurn(res.raw);
    if (!parsed) throw Object.assign(new Error("模型输出不是合法 JSON"), { code: "E_LLM_FORMAT" });
    return {
      proposals: parsed.proposals ?? [],
      text: [parsed.narrative, parsed.dialogue].filter(Boolean).join("\n"),
      usage: res.usage,
    };
  }

  /** 带失败原因的第二次询问（最多一次）；仍然坏就返回 undefined 交给上层报错 */
  private async repair(
    req: TurnRequest,
    state: WorldState,
    rejected: readonly { code: string; detail: string }[],
    _usage: Usage | undefined,
  ): Promise<{ ok: true; proposals: Proposal[]; text: string; usage?: Usage } | { ok: false; error: string }> {
    try {
      const res = await this.deps.llm.chat({
        json: true,
        messages: [
          { role: "system", content: this.prompt(state, req.actorId, req.input) },
          { role: "user", content: req.input },
          {
            role: "user",
            content: [
              "上一批 proposals 被引擎拒绝了，原因如下：",
              ...rejected.map((r) => `- ${r.code}: ${r.detail}`),
              "请只输出 JSON，修正 proposals（不要重复已成功的操作），仍用 narrative/dialogue/proposals 三个字段。",
            ].join("\n"),
          },
        ],
        maxTokens: 900,
      });
      const parsed = parseTurn(res.raw);
      if (!parsed) return { ok: false, error: "模型修复输出不是合法 JSON" };
      return {
        ok: true,
        proposals: parsed.proposals ?? [],
        text: [parsed.narrative, parsed.dialogue].filter(Boolean).join("\n"),
        usage: res.usage,
      };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
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
