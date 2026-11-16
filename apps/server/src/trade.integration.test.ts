/**
 * 支付链路的端到端验证（Issue #1 复审要求"合了数据再验"）：
 * 干净树（main + 本次修复）上加载真实的 content/modules/trade，跑「买面包」，
 * 断言 ① 钱不够 → mustKeep 触发 E_PRECONDITION、整批不落库（不扣钱、不长出物品）
 *      ② 钱够 → 扣款/建物/持有边三条一起成功
 * 不联网、不调 LLM：模块只算数，裁决由 Arbiter 做。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AttrDef, Envelope, ModuleContext, Registry, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { DefaultArbiter } from "../../../packages/engine/src/arbiter.ts";
import { ModuleHost } from "../../../packages/engine/src/modules.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { EventSourcedStore } from "../../../packages/engine/src/store.ts";

const ROOM = "room_trade";
const PLR = "plr_me";
const CANTEEN = "loc_canteen";

async function loadRegistry(): Promise<Registry> {
  const attrs = JSON.parse(await readFile(path.join(process.cwd(), "content/registry/attrs.json"), "utf8")) as { attrs: AttrDef[] };
  return new JsonRegistry({ attrs: attrs.attrs, events: [], intents: [], tools: [], ops: [] });
}

function seed(money: number): EventSourcedStore {
  const store = new EventSourcedStore({ worldId: "world_x", locId: CANTEEN });
  const ent = (id: string, kind: "plr" | "loc", name: string, attrs: Record<string, number | string>) => ({
    id, kind, name, attrs, tags: [], origin: "seed" as const, canon: true, status: "active" as const, createdAt: 0, updatedAt: 0,
  });
  const mk = (seq: number, entity: unknown): Envelope => ({
    v: 1, id: `evt_seed_${seq}`, roomId: ROOM, seq, ts: seq, actorId: "system", type: "entity.created", payload: { entity },
  });
  store.append(ROOM, [mk(1, ent(CANTEEN, "loc", "一食堂", {})), mk(2, ent(PLR, "plr", "我", { money, stamina: 50 }))]);
  return store;
}

function ctxOf(store: EventSourcedStore, registry: Registry, input: string): ModuleContext {
  const state: WorldState = store.state(ROOM);
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
      links: (kind?: string, from?: string) =>
        state.links.filter((l) => (!kind || l.kind === kind) && (!from || l.from === from)),
    },
    llm: { chat: async () => ({ raw: '{"narrative":""}', usage: { prompt: 0, completion: 0 } }) },
    log: () => undefined,
  } as unknown as ModuleContext;
}

function cause(seq: number): Envelope {
  return { v: 1, id: `evt_turn_${seq}`, roomId: ROOM, seq, ts: 1000, actorId: PLR, type: "turn.accepted", payload: {} };
}

describe("trade 支付链路（真实 content/modules/trade）", () => {
  it("钱不够：E_PRECONDITION，整批回滚（钱没少、物品没长出来）", async () => {
    const registry = await loadRegistry();
    const modules = new ModuleHost();
    await modules.load();
    const store = seed(2);
    const arbiter = new DefaultArbiter({ store, registry, now: () => 1000 });

    const out = await modules.dispatchIntent(ctxOf(store, registry, "买面包"));
    expect(out.proposals.length).toBeGreaterThan(0);

    const r = await arbiter.apply(ROOM, out.proposals, cause(3));
    expect(r.ok).toBe(false);
    expect(r.rejected[0]?.code).toBe("E_PRECONDITION");
    expect(r.events).toHaveLength(0);
    expect(store.state(ROOM).entities[PLR]?.attrs.money).toBe(2);
    expect(Object.keys(store.state(ROOM).entities)).toHaveLength(2); // 只有食堂与玩家
  });

  it("钱够：扣款 + 建物 + holds 边三条同生共死", async () => {
    const registry = await loadRegistry();
    const modules = new ModuleHost();
    await modules.load();
    const store = seed(60);
    const arbiter = new DefaultArbiter({ store, registry, now: () => 1000 });

    const out = await modules.dispatchIntent(ctxOf(store, registry, "买面包"));
    const r = await arbiter.apply(ROOM, out.proposals, cause(3));

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    // 面包带 effect(hunger)，所以是 4 条：扣款 + 建物 + 持有边 + 效果
    expect(r.applied).toHaveLength(4);
    expect(r.applied.map((p) => p.op).sort()).toEqual(["attr.delta", "attr.delta", "entity.create", "link.create"]);
    const s = store.state(ROOM);
    expect(s.entities[PLR]?.attrs.money).toBe(55);
    expect(s.entities[PLR]?.attrs.hunger).toBeDefined();
    const item = Object.values(s.entities).find((x) => x.kind === "item");
    expect(item?.name).toBe("面包");
    expect(s.links.some((l) => l.kind === "holds" && l.from === PLR && l.to === item?.id)).toBe(true);
  });
});
