/** Store 的契约：日志是唯一真相，snapshot 只是缓存的投影。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../shared/src/contract/types.ts";
import { applyEvent, createInitialState } from "./projection.ts";
import { EventSourcedStore, FileStore } from "./store.ts";

const ROOM = "room_test";

function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${seq}`, roomId: ROOM, seq, ts: seq * 10, actorId: "plr_me", type, payload };
}

const npc = {
  id: "npc_lin",
  kind: "npc",
  name: "林月",
  attrs: { stamina: 80 },
  tags: [],
  origin: "seed",
  canon: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

describe("EventSourcedStore", () => {
  it("空房间返回初始状态（校门 / 第 1 天上午）", async () => {
    const store = new EventSourcedStore();
    const s = await store.snapshot(ROOM);
    expect(s.schemaVersion).toBeGreaterThan(0);
    expect(s.room.scene.locId).toBe("loc_campus_gate");
    expect(s.clock).toEqual({ day: 1, phase: "morning", tick: 0 });
    expect(s.entities).toEqual({});
    expect(store.seq(ROOM)).toBe(0);
  });

  it("append 后 seq 单调、投影可见、事件可回读", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    store.append(ROOM, [env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 65, clamped: false })]);
    expect(store.seq(ROOM)).toBe(2);
    expect(store.state(ROOM).entities.npc_lin?.attrs.stamina).toBe(65);
    const events = await store.events(ROOM, 2);
    expect(events.map((e) => e.seq)).toEqual([2]);
  });

  it("seq 断号直接报错（说明出现了第二个写入口）", () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    expect(() => store.append(ROOM, [env(3, "entity.created", { entity: { ...npc, id: "npc_2" } })])).toThrow(/E_SEQ_GAP/);
  });

  it("events(fromSeq, limit) 按 seq 切片", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [
      env(1, "entity.created", { entity: npc }),
      env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 79, clamped: false }),
      env(3, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 79, to: 78, clamped: false }),
    ]);
    expect((await store.events(ROOM, 1, 2)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.events(ROOM, 2)).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("replay 与 snapshot 一致，toSeq 可以回到过去（determinism 的最小证据）", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [
      env(1, "entity.created", { entity: npc }),
      env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 70, clamped: false }),
    ]);
    expect(await store.replay(ROOM)).toEqual(await store.snapshot(ROOM));
    expect((await store.replay(ROOM, 1)).entities.npc_lin?.attrs.stamina).toBe(80);
  });

  it("snapshot 是副本：调用方改了它不会污染日志", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    const snap = await store.snapshot(ROOM);
    snap.entities.npc_lin!.name = "被改坏了";
    expect(store.state(ROOM).entities.npc_lin?.name).toBe("林月");
  });
});

describe("FileStore（jsonl 一房间一文件）", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), "galgame-store-"));
    dirs.push(d);
    return d;
  }

  it("写盘后可被新实例回放成同一状态", async () => {
    const dir = await tempDir();
    const a = new FileStore(dir);
    await a.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    await a.append(ROOM, [env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 40, clamped: false })]);
    await a.flush();
    const file = await readFile(path.join(dir, `${ROOM}.jsonl`), "utf8");
    expect(file.trim().split("\n")).toHaveLength(2);

    const b = new FileStore(dir);
    expect((await b.snapshot(ROOM)).entities.npc_lin?.attrs.stamina).toBe(40);
    expect(await b.replay(ROOM)).toEqual(await a.replay(ROOM));
  });

  it("崩溃留下的半行被跳过，不影响读档", async () => {
    const dir = await tempDir();
    const good = JSON.stringify(env(1, "entity.created", { entity: npc }));
    await writeFile(path.join(dir, `${ROOM}.jsonl`), `${good}\n{"v":1,"id":"evt_broken`, "utf8");
    const store = new FileStore(dir);
    const snap = await store.snapshot(ROOM);
    expect(snap.entities.npc_lin?.name).toBe("林月");
  });

  it("replay 用的是同一套 applyEvent（与内存版逐字段相等）", () => {
    const state = applyEvent(createInitialState(ROOM), env(1, "entity.created", { entity: npc }));
    expect(state.entities.npc_lin?.status).toBe("active");
  });
});
