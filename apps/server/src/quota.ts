/**
 * 行动额度账本（收敛稿 B1，docs/03 §5.2.10）：按**限定作用域**的逻辑请求结算。
 * 状态机 reserved → running → committed / failed / unconfirmed。
 * append-only JSONL 投影（重启重建，可丢可重建，不是权威状态）；与历史提交事实对账。
 *
 * 幂等键 = userId + roomId + clientTurnId（P1-1）：单看 clientTurnId 会让不同账号/房间的
 * 同名 ID 互相误判。actorId 额外落库并在复用 ID 时校验，避免同房间不同角色混用同一逻辑 ID。
 * 重启恢复（P1-2）：旧进程遗留的 running 不可能仍在执行 → 转 unconfirmed 待核对；
 * reserved 尚未真正开跑 → 转 failed 释放额度。否则账号会被永久 E_TURN_BUSY / 占额度。
 * 预留过期不自动释放：unconfirmed 需核对到提交事实或管理员 resolve 才结案（#34 未交付的残留风险）。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type LedgerState = "reserved" | "running" | "committed" | "failed" | "unconfirmed";

export interface LedgerEntry {
  clientTurnId: string;
  roomId: string;
  userId: string;
  /** 房间内角色 id；参与复用 ID 的一致性校验（见 reserve） */
  actorId?: string;
  state: LedgerState;
  day: string;
  reservedAt: number;
  settledAt?: number;
  turnId?: string;
  committedSeq?: number;
}

/** 限定作用域：提交/查询/对账/结案都按它定位同一逻辑请求 */
export interface TurnScope {
  userId: string;
  roomId: string;
  actorId?: string;
  clientTurnId: string;
}

export type ReserveResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; code: "E_RATE_LIMITED" | "E_TURN_BUSY" | "E_PRECONDITION"; message: string; committedSeq?: number };

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.clientTurnId === "string" && typeof e.roomId === "string" && typeof e.userId === "string" &&
    typeof e.state === "string" && typeof e.day === "string" && typeof e.reservedAt === "number"
  );
}

/** 幂等键：账号 + 房间 + 逻辑请求 ID（\\u0000 分隔，避免拼接歧义） */
function scopeKey(s: { userId: string; roomId: string; clientTurnId: string }): string {
  return `${s.userId}\u0000${s.roomId}\u0000${s.clientTurnId}`;
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 占用每日额度的状态：failed 释放，其余（含待核对）保守占用直到结案 */
const OCCUPYING: ReadonlySet<LedgerState> = new Set(["reserved", "running", "committed", "unconfirmed"]);

export class TurnLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isEntry(parsed)) continue;
        // P1-2：旧进程在途状态不可能还活着。running（已开跑，结果未知）→ 待核对；
        // reserved（还没真正开跑）→ failed 释放额度。避免重启后账号被永久阻塞。
        const entry: LedgerEntry =
          parsed.state === "running" ? { ...parsed, state: "unconfirmed", settledAt: Date.now() } :
          parsed.state === "reserved" ? { ...parsed, state: "failed", settledAt: Date.now() } :
          parsed;
        this.entries.set(scopeKey(entry), entry);
      } catch {
        // 半截行跳过
      }
    }
  }

  /** 等待所有排队/进行中的写盘落定（读后写一致性；测试用它替代 sleep） */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** 按限定作用域查找；传字符串则按 clientTurnId 全表唯一匹配（管理员/测试便捷入口） */
  get(query: TurnScope | string): LedgerEntry | undefined {
    if (typeof query === "string") {
      const key = this.uniqueKey(query);
      return key ? this.entries.get(key) : undefined;
    }
    return this.entries.get(scopeKey(query));
  }

  list(filter: { userId?: string; state?: LedgerState } = {}): LedgerEntry[] {
    return [...this.entries.values()].filter(
      (e) => (!filter.userId || e.userId === filter.userId) && (!filter.state || e.state === filter.state),
    );
  }

  todayTurns(userId: string, now = Date.now()): number {
    const day = dayKey(now);
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.userId === userId && e.day === day && OCCUPYING.has(e.state)) count += 1;
    }
    return count;
  }

  reserve(opts: { userId: string; roomId: string; actorId?: string; clientTurnId: string; dailyLimit: number | null; actionsEnabled: boolean; now?: number }): ReserveResult {
    const now = opts.now ?? Date.now();
    if (!opts.actionsEnabled) {
      return { ok: false, code: "E_RATE_LIMITED", message: "本轮体验已暂停新行动" };
    }
    const existing = this.entries.get(scopeKey(opts));
    if (existing) {
      // 同一账号+房间+ID 但换了角色：拒绝，避免两个角色混用同一逻辑 ID
      if (existing.actorId && opts.actorId && existing.actorId !== opts.actorId) {
        return { ok: false, code: "E_PRECONDITION", message: "该行动 ID 已用于本房间的其他角色" };
      }
      if (existing.state === "committed") {
        return { ok: false, code: "E_PRECONDITION", message: "该行动已提交，请刷新后继续", committedSeq: existing.committedSeq };
      }
      if (existing.state === "running") return { ok: false, code: "E_TURN_BUSY", message: "该行动仍在执行" };
      if (existing.state === "unconfirmed") return { ok: false, code: "E_PRECONDITION", message: "该行动结果待核对，请先确认" };
      // failed：允许以同一逻辑 ID 重试
    }
    for (const e of this.entries.values()) {
      if (e.userId === opts.userId && e.state === "running") {
        return { ok: false, code: "E_TURN_BUSY", message: "上一个行动尚未结束" };
      }
    }
    if (opts.dailyLimit !== null && this.todayTurns(opts.userId, now) >= opts.dailyLimit) {
      return { ok: false, code: "E_RATE_LIMITED", message: "本轮体验额度已用完" };
    }
    const entry: LedgerEntry = {
      clientTurnId: opts.clientTurnId, roomId: opts.roomId, userId: opts.userId,
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      state: "reserved", day: dayKey(now), reservedAt: now,
    };
    this.entries.set(scopeKey(entry), entry);
    void this.append(entry);
    return { ok: true, entry };
  }

  transition(query: TurnScope | string, state: LedgerState, extra: { turnId?: string; committedSeq?: number } = {}): LedgerEntry | undefined {
    const key = typeof query === "string" ? this.uniqueKey(query) : scopeKey(query);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const next: LedgerEntry = { ...entry, state, settledAt: Date.now(), ...extra };
    this.entries.set(key, next);
    void this.append(next);
    return next;
  }

  /**
   * 关键状态（running）必须确认落盘后才允许开跑：写失败向调用方抛错，由调用方在 head 之前中止。
   * 普通 transition 只排队写、错误被吞（账本是可重建投影），不足以证明「磁盘上已是 running」——
   * 否则中断时磁盘只有 reserved，重启会误判 failed 并允许重试已开跑的回合。
   */
  async transitionDurable(query: TurnScope, state: LedgerState, extra: { turnId?: string; committedSeq?: number } = {}): Promise<LedgerEntry | undefined> {
    const key = scopeKey(query);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const next: LedgerEntry = { ...entry, state, settledAt: Date.now(), ...extra };
    this.entries.set(key, next);
    await this.append(next);
    return next;
  }

  /** 管理员人工对账：把待核对/预留结案为 committed 或 failed（可按作用域精确定位） */
  resolve(query: TurnScope | string, resolution: "committed" | "failed", committedSeq?: number): LedgerEntry | undefined {
    return this.transition(query, resolution, resolution === "committed" ? { committedSeq } : {});
  }

  /** 字符串查询：clientTurnId 全表恰好一条才返回键；多条=歧义，要求调用方带上作用域 */
  private uniqueKey(clientTurnId: string): string | undefined {
    let found: string | undefined;
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.clientTurnId === clientTurnId) {
        found = key;
        count += 1;
      }
    }
    return count === 1 ? found : undefined;
  }

  private append(entry: LedgerEntry): Promise<void> {
    const run = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}