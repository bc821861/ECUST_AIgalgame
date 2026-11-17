/**
 * 对话页：开场剧情 + 玩家输入 + 流式叙事，逐字打出。
 * 纯展示组件：状态与请求都来自 App（本组件不做任何推演，不缓存权威状态）。
 */
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
  onSkipLog,
}: ChatPanelProps) {
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
        <div className="log" onClick={onSkipLog} title="点击可跳过打字动画">
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
