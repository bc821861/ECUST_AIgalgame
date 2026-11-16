import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { createSoloRoom, fetchState, runTurn } from "./api.ts";
import DraftsPanel from "./DraftsPanel.tsx";
import MapPanel from "./MapPanel.tsx";
import { ACTOR, phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";

type Tab = "chat" | "map" | "drafts";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "map", label: "地图" },
  { id: "drafts", label: "审核" },
];

let lineId = 0;

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [roomId, setRoomId] = useState<string>("");
  const [state, setState] = useState<WorldState | null>(null);
  const [view, setView] = useState<ViewPatch>({});
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const turnSeq = useRef(0);

  const push = useCallback((kind: LineKind, text: string) => {
    setLines((prev) => [...prev, { id: ++lineId, kind, text }]);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const id = await createSoloRoom();
        setRoomId(id);
        setState(await fetchState(id));
        push("system", `已进入房间 ${id}｜ECUST 校园`);
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, [push]);

  /** 地图操作后重拉 /state；只刷新服务端权威数据，不在前端推演 */
  const refreshState = useCallback(() => {
    if (!roomId) return;
    void fetchState(roomId).then(setState).catch(() => undefined);
  }, [roomId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !roomId) return;
    setBusy(true);
    setErr("");
    setInput("");
    push("player", text);
    const clientTurnId = `${Date.now()}_${++turnSeq.current}`;
    let narrative = "";
    try {
      await runTurn(roomId, ACTOR, text, clientTurnId, {
        onDelta: (field, chunk) => {
          if (field !== "narrative") return;
          narrative += chunk;
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "narrative") return [...prev.slice(0, -1), { ...last, text: narrative }];
            return [...prev, { id: ++lineId, kind: "narrative", text: narrative }];
          });
        },
        onPatch: (s) => setState(s),
        onUi: (v) => setView((old) => ({ ...old, ...v })),
        onError: (code, message) => setErr(`${code}: ${message}`),
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      void fetchState(roomId).then(setState).catch(() => undefined);
    }
  }, [busy, input, push, roomId]);

  const panels = view.panels ?? {};
  const pos = view.position;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>ECUST · AI 校园</h1>
          <span className="muted">{roomId ? `room ${roomId}` : "连接中…"}</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="muted clock">
          {state ? `第 ${state.clock.day} 天 · ${phaseLabel(state.clock.phase)}` : ""}
        </div>
      </header>

      <div className="app-body">
        {tab === "chat" && (
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
              {Object.entries(panels).map(([k, rows]) => (
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
              <div className="log">
                {lines.map((l) => (
                  <p key={l.id} className={`line ${l.kind}`}>
                    {l.text}
                  </p>
                ))}
                {busy && <p className="line system">…</p>}
              </div>
              {err && <div className="err">{err}</div>}
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="你要做什么？（自然语言，例如：去图书馆找林老师问问昨天的传闻）"
                  disabled={busy || !roomId}
                />
                <button type="submit" disabled={busy || !roomId}>
                  行动
                </button>
              </form>
            </main>
          </>
        )}

        {tab === "map" &&
          (roomId ? (
            <MapPanel roomId={roomId} actorId={ACTOR} push={push} onRefreshState={refreshState} />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}

        {tab === "drafts" &&
          (roomId ? (
            <DraftsPanel roomId={roomId} push={push} onRefreshState={refreshState} />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}
      </div>
    </div>
  );
}
