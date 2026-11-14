/**
 * Arbiter：唯一写入口（AGENTS.md I1）。LLM 与模块只能"提议"，这里"裁决"。
 *
 * 一次 apply = 逐条校验 → 在状态副本上试算 → 整批通过才追加事件。
 * 拦下的提案进 rejected[]（02 §4：坏条目丢弃、不阻断其余条目），
 * 唯一的例外是 op 名不在 12 个原语闭集内：那是代码写错了，整批回滚。
 */

import type {
  ApplyResult,
  Envelope,
  OpName,
  Proposal,
  Rejected,
  Registry,
  RoomId,
  ValidationResult,
  WorldState,
} from "../../shared/src/contract/types.ts";
import { OP_NAMES } from "../../shared/src/contract/types.ts";
import { applyEvent } from "./projection.ts";
import type { OpLimits } from "./arbiter.ops.ts";
import { validateOp } from "./arbiter.ops.ts";
import type { EventLog } from "./store.ts";

/** 全部来自 docs/02 §3、03 §8 与 03 §10.4 的默认值；改这里等于改玩法手感，要同步文档 */
export type ArbiterLimits = OpLimits & {
  xWritesPerTurn: number;
};

export const DEFAULT_LIMITS: ArbiterLimits = {
  npc: 24,
  loc: 40,
  item: 200,
  plots: 6,
  presentMax: 16,
  nameMax: 24,
  tagsMax: 16,
  xKeysPerEntity: 32,
  xWritesPerTurn: 8,
  maxDeltaPerTurn: 25,
  memoryContentMax: 500,
  memoryTagsMax: 8,
};

export interface ArbiterOptions {
  /** 必须是 EventLog 而不是 Store：只有 Arbiter 能拿到 append */
  store: EventLog;
  registry: Registry;
  limits?: Partial<ArbiterLimits>;
  /** 事件 ts；测试里注入固定值，便于断言全量事件 */
  now?: () => number;
}

export class DefaultArbiter {
  private readonly store: EventLog;
  private readonly registry: Registry;
  private readonly limits: ArbiterLimits;
  private readonly now: () => number;

  constructor(opts: ArbiterOptions) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.now = opts.now ?? Date.now;
  }

  /** 只校验不落库：给 Turn 做"先 dryRun 再 apply"的两段式，也方便单元测试 */
  async dryRun(roomId: RoomId, ops: Proposal[]): Promise<ValidationResult> {
    const state = await this.store.snapshot(roomId);
    const sim = this.simulate(roomId, state, ops, this.pseudoCause(roomId));
    return { ok: !sim.fatal && sim.rejected.length === 0, rejected: sim.rejected };
  }

  async apply(roomId: RoomId, ops: Proposal[], cause: Envelope): Promise<ApplyResult> {
    const state = await this.store.snapshot(roomId);
    const sim = this.simulate(roomId, state, ops, cause);
    if (sim.fatal) return { ok: false, seq: this.store.seq(roomId), applied: [], rejected: sim.rejected, events: [] };
    if (sim.events.length > 0) this.store.append(roomId, sim.events);
    return { ok: true, seq: this.store.seq(roomId), applied: sim.applied, rejected: sim.rejected, events: sim.events };
  }

  private pseudoCause(roomId: RoomId): Envelope {
    return {
      v: 1,
      id: "dry-run",
      roomId,
      seq: this.store.seq(roomId),
      ts: this.now(),
      actorId: "system",
      type: "arbiter.dryRun",
      payload: {},
    };
  }

  /**
   * 试算循环。它改的是快照副本：任何一步抛异常事件都不会进日志，
   * 所以"先算完再提交"本身就是回滚机制，不需要 undo 栈。
   */
  private simulate(
    roomId: RoomId,
    base: WorldState,
    ops: Proposal[],
    cause: Envelope,
  ): { events: Envelope[]; applied: Proposal[]; rejected: Rejected[]; fatal: boolean } {
    let state = base;
    let xWrites = 0;
    const events: Envelope[] = [];
    const applied: Proposal[] = [];
    const rejected: Rejected[] = [];
    const startSeq = this.store.seq(roomId);

    for (const proposal of ops) {
      const op = proposal && typeof proposal.op === "string" ? proposal.op : undefined;
      if (op === undefined || !(OP_NAMES as readonly string[]).includes(op)) {
        // 未知 op 不是"这条数据脏"，而是调用方版本不一致，继续跑只会写坏世界
        rejected.push({ proposal, code: "E_ILLEGAL_OP", detail: `op ${String(op)} 不在 12 个原语闭集内` });
        return { events: [], applied: [], rejected, fatal: true };
      }
      const args = proposal.args ?? {};
      const key = typeof args.key === "string" ? args.key : "";
      if ((op === "attr.delta" || op === "attr.set") && key.startsWith("x.")) {
        xWrites += 1;
        if (xWrites > this.limits.xWritesPerTurn) {
          rejected.push({ proposal, code: "E_X_LIMIT", detail: `x. 区每批最多写 ${this.limits.xWritesPerTurn} 条` });
          continue;
        }
      }
      const result = validateOp(op as OpName, args, { state, registry: this.registry, cause }, proposal, this.limits);
      if ("fail" in result) {
        rejected.push({ proposal, code: result.fail.code, detail: result.fail.detail });
        continue;
      }
      const seq = startSeq + events.length + 1;
      const env: Envelope = {
        v: 1,
        id: `evt_${roomId}_${seq}`,
        roomId,
        seq,
        ts: this.now(),
        actorId: cause.actorId,
        type: result.event.type,
        payload: result.event.payload,
        causedBy: cause.id,
      };
      events.push(env);
      applied.push(proposal);
      state = applyEvent(state, env);
    }
    return { events, applied, rejected, fatal: false };
  }
}
