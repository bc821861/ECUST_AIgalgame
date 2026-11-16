/**
 * npc.scene —— 场景对话导演（Map v0.1）。
 *
 * 只按 seed.lines 顺序把种子台词交给对应 NPC 说出来：不调 LLM、不产 Proposal、
 * 不写记忆。场景模板与台词都来自 content（world_map.json / published.json），
 * 所以新增一段场景对话不需要改引擎或导演。
 */
import type {
  DialogueDirector,
  DialogueSession,
  DialogueStep,
  ModuleContext,
} from "../../packages/shared/src/contract/types.ts";

interface SceneSeed {
  sceneId: string;
  dialogueId: string;
  npcId: string;
  npcName: string;
  lines: string[];
}

const MAX_TURNS = 8;

/** seed 来自 MapService.openDialogue；这里再校验一次，坏数据就安静结束而不是抛异常 */
function readSeed(seed: Record<string, unknown>): SceneSeed | undefined {
  const { sceneId, dialogueId, npcId, npcName, lines } = seed;
  if (typeof sceneId !== "string" || typeof dialogueId !== "string") return undefined;
  if (typeof npcId !== "string" || typeof npcName !== "string") return undefined;
  if (!Array.isArray(lines) || lines.length === 0 || !lines.every((l) => typeof l === "string")) return undefined;
  return { sceneId, dialogueId, npcId, npcName, lines };
}

const director: DialogueDirector = {
  id: "npc.scene",

  async nextTurn(session: DialogueSession, ctx: ModuleContext): Promise<DialogueStep> {
    void ctx; // 本导演只搬台词，不读世界状态、不调 LLM
    const seed = readSeed(session.seed);
    if (!seed) {
      return { sessionId: session.id, turn: session.turn, utterances: [], proposals: [], done: true };
    }
    // DialogueHost 在调用导演前已经把 session.turn +1，所以第 1 轮 = lines[0]
    const index = Math.min(session.turn - 1, seed.lines.length - 1);
    const text = seed.lines[Math.max(0, index)] ?? "";
    const maxTurns = Math.min(session.maxTurns, seed.lines.length, MAX_TURNS);
    const done = session.turn >= maxTurns || index >= seed.lines.length - 1;
    return {
      sessionId: session.id,
      turn: session.turn,
      utterances: text === "" ? [] : [{ actorId: seed.npcId, text }],
      proposals: [],
      done,
    };
  },
};

export default director;
