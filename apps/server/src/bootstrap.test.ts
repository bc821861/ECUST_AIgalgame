/**
 * 装配层回归测试：真实 content/ + tempDir 存档。
 *
 * 覆盖三个曾经静默坏掉的点：
 *   ① canon 没写 startLocId 时开场场景必须是 locs[0]（否则建房的 move.to 全部不相邻）；
 *   ② 玩家与 NPC 的开场 located_in / presentIds 必须真的落库；
 *   ③ solo 房 members 为空时 tick 的 playerActorId 仍应是玩家而不是 "system"。
 */
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-bootstrap-test-"),
    contentDir: "content",
    adminToken: "dev-admin",
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
  };
}

describe("bootstrap", () => {
  it("建房把玩家与 NPC 的初始位置真正写进世界", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const state = await deps.store.snapshot(roomId);

    expect(state.room.scene.locId).toBe("loc_library");
    expect(state.room.scene.presentIds).toEqual([actorId]);
    for (const npcId of ["npc_zhou", "npc_lin", "npc_ma"]) {
      const link = state.links.find((l) => l.kind === "located_in" && l.from === npcId);
      expect(link?.to, `NPC ${npcId} 的初始 located_in`).toBe("loc_library");
    }
  });

  it("tick 用玩家 actorId 推进日程，且 NPC 真的移动", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const res = await deps.map.tick(roomId, { advance: true });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.map.clock.phase).toBe("noon");
    expect(res.map.player.actorId).toBe(actorId);
    expect(res.moved.length).toBe(3);
    expect(res.map.npcs.every((n) => n.locId === "loc_canteen")).toBe(true);
  });
});
