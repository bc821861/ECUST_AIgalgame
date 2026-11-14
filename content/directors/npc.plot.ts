/**
 * npc.plot —— NPC 密谋导演（M0 占位）。
 * 导演只说话 + 只提议；记忆/关系的视角化写入由引擎骨架做（见 04 §7）。
 * TODO(M0)：接 ctx.llm 生成 utterances，并按剧情线提议 plot.upsert / memory.write。
 */
import type {
  DialogueDirector,
  DialogueSession,
  DialogueStep,
  ModuleContext,
  Proposal,
} from "../../packages/shared/src/contract/types.ts";

const director: DialogueDirector = {
  id: "npc.plot",

  async nextTurn(session: DialogueSession, ctx: ModuleContext): Promise<DialogueStep> {
    void ctx; // M0 不调 LLM，先不读 ctx，避免误用未实现的端口
    const [a, b] = session.participants;
    const utterances =
      a && b
        ? [
            { actorId: a, text: "（压低声音）走廊里别谈这个。" },
            { actorId: b, text: "（点头）晚上操场，老地方见。" },
          ]
        : [];
    const proposals: Proposal[] = [];
    const turn = session.turn + 1;
    return { sessionId: session.id, turn, utterances, proposals, done: turn >= session.maxTurns };
  },
};

export default director;
