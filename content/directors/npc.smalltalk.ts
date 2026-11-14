/**
 * npc.smalltalk —— NPC 闲聊导演（M0 占位）。
 * 与 npc.plot 的差别只在话题与时长：这里短、轻、不产生任何 op。
 * TODO(M0)：接 ctx.llm 生成 utterances；说完可用 memory.write 记一句「今天聊过」。
 */
import type {
  DialogueDirector,
  DialogueSession,
  DialogueStep,
  ModuleContext,
  Proposal,
} from "../../packages/shared/src/contract/types.ts";

const director: DialogueDirector = {
  id: "npc.smalltalk",

  async nextTurn(session: DialogueSession, ctx: ModuleContext): Promise<DialogueStep> {
    void ctx; // M0 不调 LLM
    const [a, b] = session.participants;
    const utterances =
      a && b
        ? [
            { actorId: a, text: "今天食堂的番茄炒蛋又咸了。" },
            { actorId: b, text: "你昨天不是还说好吃？" },
          ]
        : [];
    const proposals: Proposal[] = [];
    const turn = session.turn + 1;
    return { sessionId: session.id, turn, utterances, proposals, done: turn >= Math.min(session.maxTurns, 2) };
  },
};

export default director;
