/**
 * 对话页：开场剧情 + 玩家输入 + 流式叙事，逐字打出。
 * 纯展示组件：状态与请求都来自 App（本组件不做任何推演，不缓存权威状态）。
 */
import { useEffect, useRef } from "react";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
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
  onSkipLog,
}: ChatPanelProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  // 是否"跟着最新一条走"：玩家往上翻历史时不打扰，回到底部附近后自动恢复跟随
  const stickRef = useRef(true);

  const scrollToBottom = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  // 挂载即定位到最新：从地图点完场景切回来时，最新剧情在底部而不是顶部
  useEffect(() => {
    stickRef.current = true;
    scrollToBottom();
  }, []);

  // 新行出现、或打字机推进一个字，都跟着往下走（按"是否贴底"决定，不抢玩家滚动）
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [lines, typing?.text]);

  return (
    <>
      <aside className="side">
        {pos && (
          <section>
            <h2>{pos.name}</h2>
            <div className="muted">
              在场：{pos.actors.filter((a) => a.present).map((a) => a.name).join("、") || "只有你"}
            </div>
            <div className="muted">出口：{pos.exits.map((e) => e.name).join("、") || "无"}</div>
          </section>
        )}
        {Object.entries(panels ?? {}).map(([k, rows]) => (
          <section key={k}>
            <h2>{k}</h2>
            <dl>
              {rows.map((r) => (
                <div className="row" key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>
                    {String(r.value)}
                    {r.unit ?? ""}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section>
          <h2>世界</h2>
          <div className="muted">
            第 {state?.clock.day ?? 1} 天 · {state ? phaseLabel(state.clock.phase) : "—"} · 实体{" "}
            {state ? Object.keys(state.entities).length : 0}
          </div>
        </section>
      </aside>
      <main className="main">
        <div
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 距底 < 120px 视为"贴底"：继续跟新内容；往上翻历史则暂停跟随
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
          onClick={() => {
            onSkipLog();
            // 点击 = 跳过动画并把视线带回最新剧情
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
            placeholder="你要做什么？（自然语言，例如：去图书馆找林老师问问昨天的传闻）"
            disabled={busy || !state}
          />
          <button type="submit" disabled={busy || !state}>
            行动
          </button>
        </form>
      </main>
    </>
  );
}
