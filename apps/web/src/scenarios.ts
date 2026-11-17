/**
 * 开局剧本与 NPC 公开档案的 HTTP 层（docs/03 §5.2.6）。
 *
 * 文案与身份都是内容数据（`content/scenarios/{openings,npcs}.json`），由服务端
 * `GET /api/v1/scenarios` 下发；这里只保留类型与请求，不在前端硬编码任何开局文本（issue #3）。
 * 拉不到时调用方降级为「无预设开局」。
 */
import { request, unwrap } from "./http.ts";

export interface Scenario {
  id: string;
  name: string;
  /** 一句话身份，显示在剧情页与图鉴页头 */
  role: string;
  /** 一句话诱惑（标题页卡片上的副标题） */
  tagline: string;
  /** 开场正文，按段落 */
  opening: string[];
  /** 第一条建议行动（旧字段，保留兼容） */
  hint: string;
  /**
   * 开局的快捷行动建议：点一下就等于说出这句话。
   * 内容数据里给了就用它，没给就退回 hint（整句显示，不可点）。
   */
  suggestions?: string[];
}

/** 图鉴用的公开人物档案；id 与房间内 npc 实体 id 对齐 */
export interface NpcProfile {
  id: string;
  role: string;
  traits: string[];
  line: string;
  /** 路过时头顶气泡里的短句：一句台词，够读出这个人此刻的态度 */
  mutter?: string;
}

/** 服务端同时下发开局列表与 NPC 档案（图鉴端点也会自己拼装档案） */
export async function fetchScenarios(): Promise<Scenario[]> {
  const res = await request<{ openings: Scenario[] }>("scenarios", "/api/v1/scenarios");
  return unwrap(res).openings;
}

/** 只要 NPC 档案（大地图头顶气泡用），与 fetchScenarios 打同一个端点 */
export async function fetchNpcProfiles(): Promise<NpcProfile[]> {
  const res = await request<{ npcs: NpcProfile[] }>("scenarios", "/api/v1/scenarios");
  return unwrap(res).npcs ?? [];
}
