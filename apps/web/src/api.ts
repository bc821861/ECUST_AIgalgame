/** 前端只做两件事：发行动、渲染服务端 View。不存权威状态。 */
import type {
  TurnEvent,
  WorldState,
  ViewPatch,
} from "../../../packages/shared/src/contract/types.ts";
import { jsonHeaders } from "./http.ts";

export type { GameClock, Phase } from "../../../packages/shared/src/contract/types.ts";
export { GameError } from "./http.ts";
// 地图 / 场景草案的 HTTP 层单独成文件（AGENTS.md §6：文件 ≤ 300 行），这里保持统一入口。
export * from "./api-map.ts";

export interface TurnStreamHandlers {
  onAccepted?: (turnId: string) => void;
  onDelta?: (field: "narrative" | "dialogue", text: string) => void;
  onPatch?: (state: WorldState, ops: unknown[]) => void;
  onUi?: (view: ViewPatch) => void;
  onCommit?: (seq: number) => void;
  onError?: (code: string, message: string) => void;
}

export async function fetchState(roomId: string): Promise<WorldState> {
  const r = await fetch(`/api/v1/rooms/${roomId}/state`);
  if (!r.ok) throw new Error(`state ${r.status}`);
  return (await r.json()) as WorldState;
}

export async function createSoloRoom(): Promise<string> {
  const r = await fetch(`/api/v1/rooms`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ mode: "solo" }) });
  if (!r.ok) throw new Error(`create room ${r.status}`);
  const d = (await r.json()) as { roomId: string };
  return d.roomId;
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
    case "turn.patch": h.onPatch?.(ev.state, ev.ops); break;
    case "turn.ui": h.onUi?.(ev.view); break;
    case "turn.commit": h.onCommit?.(ev.seq); break;
    case "turn.error":
    case "turn.rejected": h.onError?.(ev.code, ev.message); break;
    default: break;
  }
}
