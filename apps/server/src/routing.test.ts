/**
 * 中文输入的路由回归（审阅 M5）：真实 content/modules 下，
 * 交易意图必须让 trade 认领（"去食堂买面包"是买东西不是走路），
 * 纯移动/观察仍由 map 认领。不联网、不调 LLM。
 */
import { describe, expect, it } from "vitest";
import type { ModuleContext, Registry, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { ModuleHost } from "../../../packages/engine/src/modules.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";

const ROOM = "room_route";
const PLR = "plr_me";
const CANTEEN = "loc_canteen";
const PLAYGROUND = "loc_playground";

function seed(): { store: { state: (roomId: string) => WorldState } } {
  const ent = (id: string, kind: "plr" | "loc", name: string) => ({
    id,
    kind,
    name,
    attrs: (kind === "plr" ? { money: 200, stamina: 100 } : {}) as Record<string, number>,
    tags: [],
    origin: "seed" as const,
    canon: true,
    status: "active" as const,
    createdAt: 0,
    updatedAt: 0,
  });
  const state: WorldState = {
    schemaVersion: 2,
    room: { id: ROOM, mode: "solo", worldId: "w", members: [], scene: { locId: CANTEEN, presentIds: [PLR] }, createdAt: 0, lastActiveAt: 0 },
    entities: { [CANTEEN]: ent(CANTEEN, "loc", "一食堂"), [PLAYGROUND]: ent(PLAYGROUND, "loc", "操场"), [PLR]: ent(PLR, "plr", "我") },
    links: [
      { id: "l1", kind: "located_in", from: CANTEEN, to: PLAYGROUND, createdAt: 0 },
      { id: "l2", kind: "located_in", from: PLAYGROUND, to: CANTEEN, createdAt: 0 },
      { id: "l3", kind: "located_in", from: PLR, to: CANTEEN, createdAt: 0 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
  return { store: { state: () => state } };
}

function ctxOf(state: WorldState, registry: Registry, input: string): ModuleContext {
  const e = (id: string) => state.entities[id];
  return {
    roomId: ROOM,
    actorId: PLR,
    input,
    state,
    registry,
    clock: state.clock,
    query: {
      entity: (id: string) => e(id),
      attr: (entityId: string, key: string) => e(entityId)?.attrs[key],
      present: () => [...state.room.scene.presentIds],
      links: (kind?: string, from?: string) => state.links.filter((l) => (!kind || l.kind === kind) && (!from || l.from === from)),
    },
    llm: { chat: async () => ({ raw: '{"narrative":""}', usage: { prompt: 0, completion: 0 } }) },
    log: () => undefined,
  } as unknown as ModuleContext;
}

describe("中文输入路由（真实 content/modules）", () => {
  it("「去食堂买面包」由 trade 认领：第一条提案是扣钱", async () => {
    const modules = new ModuleHost();
    await modules.load();
    const { store } = seed();
    const out = await modules.dispatchIntent(ctxOf(store.state(ROOM), new JsonRegistry(), "去食堂买面包"));

    expect(out.ok).toBe(true);
    const first = out.proposals[0];
    expect(first?.op).toBe("attr.delta");
    expect(first?.args).toMatchObject({ entityId: PLR, key: "money" });
    expect(out.proposals.some((p) => p.op === "entity.create")).toBe(true); // 买到面包长出物品
  });

  it("「看看面包多少钱」不被 map.look 截走", async () => {
    const modules = new ModuleHost();
    await modules.load();
    const { store } = seed();
    const out = await modules.dispatchIntent(ctxOf(store.state(ROOM), new JsonRegistry(), "看看面包多少钱"));

    // trade 认领（browse 或 buy），至少不会返回 map.look 的场景 facts
    const facts = out.facts?.join("") ?? "";
    expect(facts).not.toContain("【一食堂】");
  });

  it("纯移动「去操场」仍由 map 认领：产出 move.to", async () => {
    const modules = new ModuleHost();
    await modules.load();
    const { store } = seed();
    const out = await modules.dispatchIntent(ctxOf(store.state(ROOM), new JsonRegistry(), "去操场"));

    expect(out.ok).toBe(true);
    expect(out.proposals.some((p) => p.op === "move.to")).toBe(true);
  });

  it("纯观察「看看四周」仍由 map 认领：返回场景 facts", async () => {
    const modules = new ModuleHost();
    await modules.load();
    const { store } = seed();
    const out = await modules.dispatchIntent(ctxOf(store.state(ROOM), new JsonRegistry(), "看看四周"));

    expect(out.ok).toBe(true);
    expect(out.facts?.[0]).toContain("一食堂");
    expect(out.proposals).toHaveLength(0);
  });
});
