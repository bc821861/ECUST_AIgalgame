/**
 * 叙事提示词：Turn 每回合组装一次。
 * 改这个文件必须 bump PROMPT_VERSION（AGENTS.md §4 / docs/03 §8），否则回放与 eval 对不上。
 *
 * 顺序刻意固定：稳定前缀（身份/世界规则）在前，逐回合变化的部分在后，
 * 这样 deepseek 的上下文缓存才命中得上（命中价是未命中的 2%）。
 */
import type { ActorId, WorldState } from "../../shared/src/contract/types.ts";

export interface PromptOptions {
  /** 现实锚定层追加的行（世界规则 + 本回合的诱导类型） */
  framing?: string[];
}

export function buildTurnPrompt(state: WorldState, actorId: ActorId, input: string, opts: PromptOptions = {}): string {
  const me = state.entities[actorId];
  const where = state.entities[state.room.scene.locId];
  return [
    "你是校园文字冒险游戏的叙事者。用第二人称、中文、克制的白描，不复述玩家原话。",
    `当前地点：${where?.name ?? "未知"}；第 ${state.clock.day} 天 ${state.clock.phase}。`,
    `玩家：${me?.name ?? actorId}。`,
    ...(opts.framing ?? []),
    "只输出 JSON，字段：narrative(环境与动作)、dialogue(NPC 台词，可为空)、proposals(状态变更提议，可为空数组)。",
    '示例：{"narrative":"…","dialogue":"…","proposals":[{"op":"attr.delta","args":{"entityId":"plr_self","key":"stamina","delta":-2},"reason":"走了半小时"}]}',
    "禁止编造未声明的属性键；只能使用 registry 中存在的属性。",
    `玩家输入：${input}`,
  ].join("\n");
}
