/**
 * npc.scene 导演契约：只搬 seed.lines，不产 Proposal、不调 LLM。
 * 用真 DialogueHost 跑完整会话，证明"轮次/收尾"由引擎骨架负责，导演只管台词。
 */
import { describe, expect, it } from "vitest";
import { DialogueHost } from "@galgame/engine";
import { makeCtx } from "@galgame/testkit";
import npcScene from "./npc.scene.ts";

const LINES = ["你来啦。", "今天的书还回来了吗？", "别站在门口。"];
const SEED = {
  sceneId: "loc_library",
  dialogueId: "dlg_lib",
  npcId: "npc_lin",
  npcName: "林夏",
  lines: LINES,
};

function makeHost(): DialogueHost {
  return new DialogueHost(() => makeCtx(), [npcScene]);
}

describe("npc.scene 导演", () => {
  it("按 seed.lines 顺序逐轮说出，最后一行标记 done", async () => {
    const host = makeHost();
    const session = await host.open({
      roomId: "room_test",
      participants: [SEED.npcId],
      directorId: "npc.scene",
      seed: SEED,
    });

    const texts: string[] = [];
    const actors = new Set<string>();
    for (let i = 0; i < LINES.length; i += 1) {
      const step = await host.step(session.id);
      expect(step.turn).toBe(i + 1);
      expect(step.proposals).toEqual([]);
      expect(step.done).toBe(i === LINES.length - 1);
      for (const u of step.utterances) actors.add(u.actorId);
      texts.push(...step.utterances.map((u) => u.text));
    }

    expect(texts).toEqual(LINES);
    expect([...actors]).toEqual([SEED.npcId]);
    // 最后一行后 session 关闭，再 step 会被引擎拒绝
    await expect(host.step(session.id)).rejects.toThrow("E_DIALOGUE_CLOSED");
  });

  it("maxTurns 小于台词数时提前收尾", async () => {
    const host = makeHost();
    const session = await host.open({
      roomId: "room_test",
      participants: [SEED.npcId],
      directorId: "npc.scene",
      seed: SEED,
      maxTurns: 2,
    });
    const first = await host.step(session.id);
    expect(first.done).toBe(false);
    const second = await host.step(session.id);
    expect(second.done).toBe(true);
    expect(second.utterances.map((u) => u.text)).toEqual([LINES[1]]);
  });

  it("坏 seed 安静结束而不是抛异常", async () => {
    const host = makeHost();
    const session = await host.open({
      roomId: "room_test",
      participants: [SEED.npcId],
      directorId: "npc.scene",
      seed: { sceneId: "loc_library" },
    });
    const step = await host.step(session.id);
    expect(step.utterances).toEqual([]);
    expect(step.proposals).toEqual([]);
    expect(step.done).toBe(true);
  });
});
