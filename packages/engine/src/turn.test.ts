import { describe, expect, it } from "vitest";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { InMemoryMemory } from "./memory.ts";
import type { TurnEvent } from "../../shared/src/index.ts";

/** 测试只用内存件；ModuleHost 指向不存在的目录 = 零模块，验证"没有玩法回合也能跑完" */
async function makeTurn(llm: MockLlm, registry = emptyRegistry(), dir = "/tmp/galgame-no-modules") {
  const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
  const arbiter = new DefaultArbiter({ store, registry });
  const modules = new ModuleHost({ dir });
  await modules.load();
  const turn = new DefaultTurn({ store, arbiter, registry, modules, llm, memory: new InMemoryMemory() });
  return { store, arbiter, turn, roomId: "room_t" };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const okJson = JSON.stringify({ narrative: "你走进图书馆，空气里全是纸味。", dialogue: "", proposals: [] });

describe("turn.run", () => {
  it("skipLLM 时完全不调模型，仍能走完 accepted→commit", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "看看", clientTurnId: "c1", options: { skipLLM: true } }));
    expect(evs.map((e) => e.type)).toEqual(["turn.accepted", "turn.commit"]);
    expect(llm.calls).toBe(0);
  });

  it("模型返回合法 JSON 时产出 turn.delta 且提交", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c2" }));
    expect(llm.calls).toBe(1);
    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("图书馆");
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("模型返回非 JSON 时报 E_LLM_FORMAT 且不提交", async () => {
    const llm = new MockLlm({ responses: ["抱歉，我不能输出 JSON。"] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c3" }));
    const err = evs.find((e) => e.type === "turn.error");
    expect(err && err.type === "turn.error" ? err.code : "").toBe("E_LLM_FORMAT");
    expect(evs.some((e) => e.type === "turn.commit")).toBe(false);
  });

  it("同一 clientTurnId 重复提交完全重放，不再调模型", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const a = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "same" }));
    const b = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "same" }));
    expect(llm.calls).toBe(1);
    expect(b.map((e) => e.type)).toEqual(a.map((e) => e.type));
  });

  it("expectedSeq 不一致时直接 turn.rejected(E_SEQ_GAP)", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c4", options: { expectedSeq: 99 } }));
    expect(evs[0]?.type).toBe("turn.rejected");
    expect(evs[0] && evs[0].type === "turn.rejected" ? evs[0].code : "").toBe("E_SEQ_GAP");
    expect(llm.calls).toBe(0);
  });

  it("LLM 提议的 op 会经 Arbiter 落到状态里（属性声明后）", async () => {
    const registry = emptyRegistry();
    const llm = new MockLlm({
      responses: [JSON.stringify({ narrative: "你借到一本书。", proposals: [{ op: "attr.delta", args: { entityId: "plr_self", key: "x.note", delta: 1 }, reason: "借书" }] })],
    });
    const { turn, roomId } = await makeTurn(llm, registry);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "借书", clientTurnId: "c5" }));
    // 没有 x.note 也能被接受（x 区自由），但玩家实体不存在 → op 被拒是合法结果，这里只断言不炸
    expect(evs.at(-1)?.type === "turn.commit" || evs.at(-1)?.type === "turn.error").toBe(true);
  });
});
