/**
 * 行动额度账本（收敛稿 B1，docs/03 §5.2.10）：状态机 / 每日额度 / 幂等 / 对账 / 重启重建。
 * 断言状态与错误码，不断言文案。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { tempDir } from "@galgame/testkit";
import { TurnLedger, dayKey } from "./quota.ts";

function ledger(): TurnLedger {
  return new TurnLedger(path.join(tempDir("galgame-quota-"), "ledger.jsonl"));
}

const base = { userId: "u_a", roomId: "room_x", dailyLimit: null as number | null, actionsEnabled: true };

describe("TurnLedger 状态机", () => {
  it("reserve → running → committed；todayTurns 计占用态", () => {
    const l = ledger();
    const r = l.reserve({ ...base, clientTurnId: "c1" });
    expect(r.ok).toBe(true);
    expect(l.get("c1")?.state).toBe("reserved");
    expect(l.todayTurns("u_a")).toBe(1);

    l.transition("c1", "running", { turnId: "t1" });
    expect(l.get("c1")?.state).toBe("running");
    l.transition("c1", "committed", { committedSeq: 7 });
    expect(l.get("c1")).toMatchObject({ state: "committed", committedSeq: 7 });
    expect(l.todayTurns("u_a")).toBe(1);
  });

  it("failed 释放额度，且允许同一逻辑 ID 重试", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "failed");
    expect(l.todayTurns("u_a")).toBe(0);
    const retry = l.reserve({ ...base, clientTurnId: "c1" });
    expect(retry.ok).toBe(true);
    expect(l.get("c1")?.state).toBe("reserved");
  });

  it("已提交重复提交 → E_PRECONDITION 带 committedSeq；running → E_TURN_BUSY", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "committed", { committedSeq: 9 });
    const dup = l.reserve({ ...base, clientTurnId: "c1" });
    expect(dup).toMatchObject({ ok: false, code: "E_PRECONDITION", committedSeq: 9 });

    l.reserve({ ...base, clientTurnId: "c2" });
    l.transition("c2", "running");
    expect(l.reserve({ ...base, clientTurnId: "c2" })).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
    // 同一用户另有 running 时，新逻辑 ID 也被挡
    expect(l.reserve({ ...base, clientTurnId: "c3" })).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
  });

  it("unconfirmed 保守占用额度，重复 reserve → E_PRECONDITION；管理员 resolve 结案", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "unconfirmed");
    expect(l.todayTurns("u_a")).toBe(1);
    expect(l.reserve({ ...base, clientTurnId: "c1" })).toMatchObject({ ok: false, code: "E_PRECONDITION" });

    const resolved = l.resolve("c1", "committed", 12);
    expect(resolved).toMatchObject({ state: "committed", committedSeq: 12 });
    const failed = l.resolve("c1", "failed");
    expect(failed?.state).toBe("failed");
    expect(l.todayTurns("u_a")).toBe(0);
    expect(l.resolve("missing", "failed")).toBeUndefined();
  });

  it("每日额度上限 → E_RATE_LIMITED；null 不限；总开关关闭 → E_RATE_LIMITED", () => {
    const l = ledger();
    expect(l.reserve({ ...base, clientTurnId: "c1", dailyLimit: 1 }).ok).toBe(true);
    expect(l.reserve({ ...base, clientTurnId: "c2", dailyLimit: 1 })).toMatchObject({ ok: false, code: "E_RATE_LIMITED" });
    // 不同用户互不影响
    expect(l.reserve({ ...base, userId: "u_b", clientTurnId: "c3", dailyLimit: 1 }).ok).toBe(true);
    // 总开关
    expect(l.reserve({ ...base, userId: "u_c", clientTurnId: "c4", actionsEnabled: false })).toMatchObject({ ok: false, code: "E_RATE_LIMITED" });
  });

  it("按本地日界计数；跨天不占今日额度", () => {
    const l = ledger();
    const day1 = new Date("2026-11-18T10:00:00").getTime();
    const day2 = new Date("2026-11-19T10:00:00").getTime();
    l.reserve({ ...base, clientTurnId: "c1", dailyLimit: 1, now: day1 });
    expect(l.todayTurns("u_a", day1)).toBe(1);
    expect(l.todayTurns("u_a", day2)).toBe(0);
    expect(l.reserve({ ...base, clientTurnId: "c2", dailyLimit: 1, now: day2 }).ok).toBe(true);
    expect(dayKey(day1)).toBe("2026-11-18");
  });

  it("重启从 JSONL 重建：取每个逻辑 ID 的最后状态", async () => {
    const file = path.join(tempDir("galgame-quota-reload-"), "ledger.jsonl");
    const l1 = new TurnLedger(file);
    l1.reserve({ ...base, clientTurnId: "c1" });
    l1.transition("c1", "running");
    l1.transition("c1", "committed", { committedSeq: 3 });
    l1.reserve({ ...base, clientTurnId: "c2" });
    l1.transition("c2", "failed");
    // 等串行写盘落定
    await new Promise((r) => setTimeout(r, 50));

    const l2 = new TurnLedger(file);
    await l2.load();
    expect(l2.get("c1")).toMatchObject({ state: "committed", committedSeq: 3 });
    expect(l2.get("c2")?.state).toBe("failed");
    expect(l2.todayTurns("u_a")).toBe(1);
  });

  it("list 按 userId/state 过滤", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.reserve({ ...base, userId: "u_b", clientTurnId: "c2" });
    l.transition("c2", "failed");
    expect(l.list({ userId: "u_a" }).map((e) => e.clientTurnId)).toEqual(["c1"]);
    expect(l.list({ state: "failed" }).map((e) => e.clientTurnId)).toEqual(["c2"]);
  });
});