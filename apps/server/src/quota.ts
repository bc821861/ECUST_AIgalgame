/**
 * 行动额度账本（收敛稿 B1，docs/03 §5.2.10）：按逻辑请求 clientTurnId 结算。
 * 状态机 reserved → running → committed / failed / unconfirmed。
 * append-only JSONL 投影（重启重建，可丢可重建，不是权威状态）；与历史提交事实对账。
 * 预留过期不自动释放：unconfirmed 需核对到提交事实或管理员 resolve 才结案（#34 未交付的残留风险）。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type LedgerState = "reserved" | "running" | "committed" | "failed" | "unconfirmed";

export interface LedgerEntry {
  clientTurnId: string;
  roomId: string;
  userId: string;
  state: LedgerState;
  day: string;
  reservedAt: number;
  settledAt?: number;
  turnId?: string;
  committedSeq?: number;
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
        if (isEntry(parsed)) this.entries.set(parsed.clientTurnId, parsed);
      } catch {
        // 半截行跳过
      }
    }
  }

  get(clientTurnId: string): LedgerEntry | undefined {
    return this.entries.get(clientTurnId);
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

  reserve(opts: { userId: string; roomId: string; clientTurnId: string; dailyLimit: number | null; actionsEnabled: boolean; now?: number }): ReserveResult {
    const now = opts.now ?? Date.now();
    if (!opts.actionsEnabled) {
      return { ok: false, code: "E_RATE_LIMITED", message: "本轮体验已暂停新行动" };
    }
    const existing = this.entries.get(opts.clientTurnId);
    if (existing) {
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
      state: "reserved", day: dayKey(now), reservedAt: now,
    };
    this.entries.set(entry.clientTurnId, entry);
    void this.append(entry);
    return { ok: true, entry };
  }

  transition(clientTurnId: string, state: LedgerState, extra: { turnId?: string; committedSeq?: number } = {}): LedgerEntry | undefined {
    const entry = this.entries.get(clientTurnId);
    if (!entry) return undefined;
    const next: LedgerEntry = { ...entry, state, settledAt: Date.now(), ...extra };
    this.entries.set(clientTurnId, next);
    void this.append(next);
    return next;
  }

  /** 管理员人工对账：把待核对/预留结案为 committed 或 failed */
  resolve(clientTurnId: string, resolution: "committed" | "failed", committedSeq?: number): LedgerEntry | undefined {
    return this.transition(clientTurnId, resolution, resolution === "committed" ? { committedSeq } : {});
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