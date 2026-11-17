/**
 * 对话页 = 2D 场景 + 底部对话框。
 *
 * 场景里用 WASD 走动、点 NPC 说话、点门换地方；
 * 对话框始终在底部（叙事要一直看得见），点 NPC 之后标题变成"和谁在说话"，
 * 输入框的提示也跟着换 —— 但输入仍然是自然语言，不受对话对象限制。
 */
import { useEffect, useRef, useState } from "react";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import MiniMap from "./MiniMap.tsx";
import World2D from "./World2D.tsx";
import { phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";

export interface ChatPanelProps {
  state: WorldState | null;
  panels: ViewPatch["panels"];
  pos: ViewPatch["position"];
  lines: Line[];
  /** 正在打字的那一行（打字机状态）；null = 没有在打 */
  typing: { kind: LineKind; text: string } | null;
  busy: boolean;
  err: string;
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  /** 每回合结束后的快捷行动建议（点击即说出这句话）；空数组 = 不显示 */
  suggestions: string[];
  onPick: (text: string) => void;
  /** 点左上角小地图：展开全屏地图选点 */
  roomId: string;
  onOpenMap: () => void;
  /** 点了场景里的门：交给上层走 /map/travel */
  onTravelScene: (locId: string) => void;
  /** 点击对话区 = 跳过打字动画 */
  onSkipLog: () => void;
}

export default function ChatPanel({
  state,
  panels,
  pos,
  lines,
  typing,
  busy,
  err,
  input,
  onInput,
  onSend,
  suggestions,
  onPick,
  roomId,
  onOpenMap,
  onTravelScene,
  onSkipLog,
}: ChatPanelProps) {
  const [talking, setTalking] = useState<{ id: string; name: string } | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // 是否"跟着最新一条走"：玩家往上翻历史时不打扰，回到底部附近后自动恢复跟随
  const stickRef = useRef(true);

  const scrollToBottom = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    stickRef.current = true;
    scrollToBottom();
  }, []);

  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [lines, typing?.text]);

  // 换地点后把对话对象清掉：你走出去，就不该还挂着"和谁说话"
  useEffect(() => {
    setTalking(null);
  }, [pos?.locId]);

  const stats = (Object.values(panels ?? {})[0] ?? []).slice(0, 4);

  return (
    <div className="world-page">
      <div className="world-shell">
        <World2D
          pos={pos}
          talkingTo={talking?.id ?? ""}
          busy={busy}
          onTalk={(id, name) => setTalking({ id, name })}
          onTravel={onTravelScene}
        />

        <div className="world-hud-left">
          <MiniMap roomId={roomId} onOpen={onOpenMap} />
          <div className="hud-place">
            <strong>{pos?.name ?? "—"}</strong>
            <span>{state ? `第 ${state.clock.day} 天 · ${phaseLabel(state.clock.phase)}` : "—"}</span>
          </div>
        </div>

        <div className="world-hud-right">
          {stats.map((r) => (
            <span className="hud-stat" key={r.label}>
              <i>{r.label}</i>
              <b>
                {String(r.value)}
                {r.unit ?? ""}
              </b>
            </span>
          ))}
        </div>

        {lines.length === 0 && !typing && (
          <div className="world-hint">WASD 走动 · 走近 NPC 点他说话 · 底部也能直接输入行动</div>
        )}
      </div>

      <div className={`dialog-dock${talking ? " talking" : ""}`}>
        <div className="dock-bar">
          {talking ? (
            <>
              <strong>{talking.name}</strong>
              <span className="muted">正在对话</span>
              <button type="button" className="btn ghost" onClick={() => setTalking(null)}>
                结束对话
              </button>
            </>
          ) : (
            <span className="muted">自由行动</span>
          )}
          <button type="button" className="btn ghost dock-fold" onClick={onSkipLog} title="跳过打字动画">
            ⏩
          </button>
        </div>

        <div
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
          onClick={() => {
            onSkipLog();
            stickRef.current = true;
            requestAnimationFrame(scrollToBottom);
          }}
          title="点击可跳过打字动画并定位到最新剧情"
        >
          {lines.map((l) => (
            <p key={l.id} className={`line ${l.kind}`}>
              {l.text}
            </p>
          ))}
          {typing && (
            <p className={`line ${typing.kind} typing`}>
              {typing.text}
              <span className="caret" />
            </p>
          )}
          {busy && !typing && <p className="line system">…</p>}
        </div>

        {err && <div className="err">{err}</div>}

        {suggestions.length > 0 && (
          <div className="suggestions">
            <span className="muted">你可以：</span>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="suggest-chip"
                onClick={() => onPick(s)}
                disabled={busy || !state}
                title={`说出：${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <input
            value={input}
            onChange={(e) => onInput(e.target.value)}
            placeholder={talking ? `对${talking.name}说…` : "你要做什么？（也可以直接用 WASD 走动）"}
            disabled={busy || !state}
          />
          <button type="submit" disabled={busy || !state}>
            行动
          </button>
        </form>
      </div>
    </div>
  );
}
