/** 纯前端展示辅助：只做格式化，不持有任何权威数据。 */
import { GameError } from "./api.ts";
import type { DraftStatus, MapScene, Phase } from "./api.ts";

export type LineKind = "player" | "narrative" | "npc" | "system";

export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

/** solo 房间的固定玩家 actorId（与 server 建房时一致） */
export const ACTOR = "plr_self";

const PHASE_LABELS: Record<Phase, string> = {
  morning: "早上",
  noon: "中午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜晚",
};

export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase] ?? phase;
}

const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  pending_review: "待审核",
  approved: "已通过 · 待生成",
  generating: "生成中",
  generated_pending_review: "生成待审核",
  published: "已发布",
  rejected: "已拒绝",
};

export function draftStatusLabel(status: DraftStatus): string {
  return DRAFT_STATUS_LABELS[status] ?? status;
}

export function sceneName(scenes: MapScene[], id: string): string {
  return scenes.find((s) => s.id === id)?.name ?? id;
}

export function errorMessage(e: unknown): string {
  if (e instanceof GameError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
