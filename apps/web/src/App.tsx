import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { createSoloRoom, fetchState, runTurn } from "./api.ts";

interface Line { id: number; kind: "player" | "narrative" | "npc" | "system"; text: string }

let lineId = 0;
const ACTOR = "plr_self";

export default function App() {
  const [roomId, setRoomId] = useState<string>("");
  const [state, setState] = useState<WorldState | null>(null);
  const [view, setView] = useState<ViewPatch>({});
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const turnSeq = useRef(0);

  const push = useCallback((kind: Line["kind"], text: string) => {
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
      <aside className="side">
        <h1>ECUST · AI 校园</h1>
        <div className="muted">{roomId ? `room ${roomId}` : "连接中…"}</div>
        {pos && (
          <section>
            <h2>{pos.name}</h2>
            <div className="muted">在场：{pos.actors.filter((a) => a.present).map((a) => a.name).join("、") || "只有你"}</div>
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
                  <dd>{String(r.value)}{r.unit ?? ""}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section>
          <h2>世界</h2>
          <div className="muted">
            第 {state?.clock.day ?? 1} 天 · {state?.clock.phase ?? "morning"} · 实体 {state ? Object.keys(state.entities).length : 0}
          </div>
        </section>
      </aside>
      <main className="main">
        <div className="log">
          {lines.map((l) => (
            <p key={l.id} className={`line ${l.kind}`}>{l.text}</p>
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
          <button type="submit" disabled={busy || !roomId}>行动</button>
        </form>
      </main>
    </div>
  );
}
