/** 前端只做两件事：发行动、渲染服务端 View。不存权威状态。 */
import type {
  TurnEvent,
  WorldState,
  ViewPatch,
} from "../../../packages/shared/src/contract/types.ts";
import { GameError, jsonHeaders } from "./http.ts";

export type { GameClock, Phase } from "../../../packages/shared/src/contract/types.ts";
export { GameError } from "./http.ts";
/** 存档索引条目（UI 侧 DTO；与 apps/server/src/saves.ts 的 SaveEntry 同形，刻意不跨端 import） */
export interface SaveEntry {
  roomId: string;
  scenarioId: string;
  createdAt: number;
  updatedAt: number;
  lastTurnId: string;
  lastCommittedSeq: number;
  /** 建房时服务端签发的角色 id；3.3 之前的老存档没有，恢复时从房间成员表兜底 */
  actorId?: string;
  formatVersion: number;
}

/** 旧房间/旧存档的角色 id：只用于兼容，不在新流程里猜身份 */
export const LEGACY_ACTOR_ID = "plr_self";

/** 已提交回合历史行（UI 侧 DTO；与 apps/server/src/turn-history.ts 的 TurnHistoryLine 同形） */
export interface HistoryLine {
  formatVersion: number;
  roomId: string;
  turnId: string;
  committedSeq: number;
  actorId: string;
  userId?: string;
  input: string;
  narrative: string;
  speakers: string[];
  facts: string[];
  createdAt: number;
}
// 地图 / 场景草案的 HTTP 层单独成文件（AGENTS.md §6：文件 ≤ 300 行），这里保持统一入口。
export * from "./api-map.ts";

export interface TurnStreamHandlers {
  onAccepted?: (turnId: string) => void;
  onDelta?: (field: "narrative" | "dialogue", text: string) => void;
  /** 模块给出的人话提示（"你走了 1 段路，来到一食堂。"）：不落库，只在本次流里出现 */
  onFacts?: (facts: string[]) => void;
  onPatch?: (state: WorldState, ops: unknown[]) => void;
  onUi?: (view: ViewPatch) => void;
  onCommit?: (seq: number) => void;
  onError?: (code: string, message: string) => void;
}

export async function fetchState(roomId: string): Promise<WorldState> {
  const r = await fetch(`/api/v1/rooms/${roomId}/state`, { credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 404) throw new GameError("E_ROOM_NOT_FOUND", "房间不存在或事件日志不可读");
    throw new Error(`state ${r.status}`);
  }
  return (await r.json()) as WorldState;
}

export interface RoomSession {
  roomId: string;
  actorId: string;
}

export async function createSoloRoom(scenarioId?: string): Promise<RoomSession> {
  const r = await fetch(`/api/v1/rooms`, {
    method: "POST",
    credentials: "same-origin",
    headers: { ...jsonHeaders },
    body: JSON.stringify({ mode: "solo", ...(scenarioId ? { scenarioId } : {}) }),
  });
  if (!r.ok) throw new Error(`create room ${r.status}`);
  const d = (await r.json()) as { roomId: string; actorId?: string };
  // 老服务端没有 actorId 时才回退；新服务端必须下发，客户端不再自己猜
  return { roomId: d.roomId, actorId: d.actorId || LEGACY_ACTOR_ID };
}

// ---------------------------------------------------------------- 存档 / 历史（issue #7）

/** 本人的存档索引；没有身份/服务异常时返回空列表——标题页不显示存档，不影响开局 */
export async function fetchSaves(): Promise<SaveEntry[]> {
  const r = await fetch(`/api/v1/me/saves`, { credentials: "same-origin" });
  if (!r.ok) return [];
  const d = (await r.json()) as { saves?: SaveEntry[] };
  return Array.isArray(d.saves) ? d.saves : [];
}

/** 只删索引（房间与历史保留）；返回服务端是否真的删掉了一条 */
export async function deleteSave(roomId: string): Promise<boolean> {
  const r = await fetch(`/api/v1/me/saves/${roomId}`, { method: "DELETE", credentials: "same-origin" });
  if (!r.ok) return false;
  const d = (await r.json()) as { removed?: boolean };
  return d.removed === true;
}

/** 已提交回合的对话历史（按 committedSeq 升序）。上限 200，恢复 MVP 一次拉满。 */
export async function fetchHistory(roomId: string, fromTurn?: string, limit = 200): Promise<HistoryLine[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (fromTurn) q.set("fromTurn", fromTurn);
  const r = await fetch(`/api/v1/rooms/${roomId}/history?${q.toString()}`, { credentials: "same-origin" });
  if (r.status === 404) throw new GameError("E_ROOM_NOT_FOUND", "房间不存在或没有可恢复的历史");
  if (r.status === 403) throw new GameError("E_FORBIDDEN", "只有本房间成员可以读取历史");
  if (!r.ok) throw new Error(`history ${r.status}`);
  const d = (await r.json()) as { history?: HistoryLine[] };
  return Array.isArray(d.history) ? d.history : [];
}

// ---------------------------------------------------------------- 回合（SSE）

/** POST + 读 SSE：一个回合一条流，turn.commit 后关闭 */
export async function runTurn(
  roomId: string,
  actorId: string,
  input: string,
  clientTurnId: string,
  h: TurnStreamHandlers,
): Promise<void> {
  const r = await fetch(`/api/v1/rooms/${roomId}/turns`, {
    method: "POST",
    headers: { ...jsonHeaders, accept: "text/event-stream" },
    credentials: "same-origin",
    body: JSON.stringify({ actorId, input, clientTurnId }),
  });
  if (!r.ok || !r.body) {
    h.onError?.(`HTTP_${r.status}`, await r.text().catch(() => ""));
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const ev = JSON.parse(dataLines.join("\n")) as TurnEvent;
      dispatch(ev, event, h);
    }
  }
}

function dispatch(ev: TurnEvent, _event: string, h: TurnStreamHandlers): void {
  switch (ev.type) {
    case "turn.accepted": h.onAccepted?.(ev.turnId); break;
    case "turn.delta": h.onDelta?.(ev.field, ev.text); break;
    case "turn.facts": h.onFacts?.(ev.facts); break;
    case "turn.patch": h.onPatch?.(ev.state, ev.ops); break;
    case "turn.ui": h.onUi?.(ev.view); break;
    case "turn.commit": h.onCommit?.(ev.seq); break;
    case "turn.error":
    case "turn.rejected": h.onError?.(ev.code, ev.message); break;
    default: break;
  }
}
