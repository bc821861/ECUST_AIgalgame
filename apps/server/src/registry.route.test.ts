/**
 * `/api/v1/registry` 回归（审阅 issue #3：前端不再硬编码属性键，改由注册表驱动）。
 * 只断言声明结构：标签/可见性/范围都在，且不含任何实体数值。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AttrDef } from "../../../packages/shared/src/contract/types.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { registerRoutes } from "./routes.ts";

const ATTRS: AttrDef[] = [
  { key: "stamina", type: "number", scope: ["plr", "npc"], min: 0, max: 100, default: 100, visibility: "public", display: { label: "体力", unit: "点" } },
  { key: "trust", type: "number", scope: ["plr", "npc"], min: 0, max: 100, default: 50, visibility: "self", display: { label: "信任", unit: "点" } },
  { key: "guard", type: "number", scope: ["npc"], min: 0, max: 100, default: 30, visibility: "secret", display: { label: "戒备" } },
  { key: "coord_x", type: "number", scope: ["loc", "npc", "plr"], min: 0, max: 2000, default: 0, visibility: "public", display: { label: "地图 X", hidden: true } },
] as AttrDef[];

describe("GET /api/v1/registry", () => {
  it("返回属性声明（标签/可见性/范围），并标注隐藏项", async () => {
    const app = Fastify();
    registerRoutes(app, {
      store: {},
      turn: {},
      map: {},
      registry: new JsonRegistry({ attrs: ATTRS }),
      settings: { view: () => ({ mode: "offline", baseUrl: "", model: "", persisted: false }), apply: async () => ({ ok: false }), clear: async () => undefined },
      createRoom: async () => ({ roomId: "r", actorId: "a" }),
      version: "test",
    } as never);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/registry" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; attrs: { key: string; label: string; visibility: string; hidden: boolean; max?: number }[] };
    expect(body.ok).toBe(true);
    expect(body.attrs.map((a) => a.key)).toEqual(["stamina", "trust", "guard", "coord_x"]);

    const guard = body.attrs.find((a) => a.key === "guard");
    expect(guard).toMatchObject({ label: "戒备", visibility: "secret", hidden: false, max: 100 });
    expect(body.attrs.find((a) => a.key === "coord_x")?.hidden).toBe(true);

    // 只给声明，不给数值
    expect(JSON.stringify(body)).not.toContain('"value"');
    await app.close();
  });
});
