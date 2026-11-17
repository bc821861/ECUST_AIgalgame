import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { createSoloRoom, fetchState, runTurn, travel } from "./api.ts";
import ChatPanel from "./ChatPanel.tsx";
import DraftsPanel from "./DraftsPanel.tsx";
import GalleryPanel from "./GalleryPanel.tsx";
import MapOverlay from "./MapOverlay.tsx";
import TitleScreen from "./TitleScreen.tsx";
import { DEFAULT_SCENARIO_ID, SCENARIOS, getScenario } from "./scenarios.ts";
import type { Scenario } from "./scenarios.ts";
import { turnSuggestions } from "./suggestions.ts";
import { installClickSound, setSoundOn, soundOn } from "./sfx.ts";
import { Typewriter } from "./typewriter.ts";
import { ACTOR, errorMessage, phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";

type Tab = "chat" | "gallery" | "drafts";
type Screen = "title" | "game";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "gallery", label: "图鉴" },
  { id: "drafts", label: "审核" },
];

/** 只存"上次进了哪个房间 / 选了哪个开局"，不存任何世界状态（权威状态永远在服务端） */
const ROOM_KEY = "ecust.galgame.lastRoomId";
const scenarioKey = (roomId: string) => `ecust.galgame.scenario.${roomId}`;

let lineId = 0;

export default function App() {
  const [screen, setScreen] = useState<Screen>("title");
  const [tab, setTab] = useState<Tab>("chat");
  const [roomId, setRoomId] = useState<string>("");
  const [savedRoomId, setSavedRoomId] = useState<string>("");
  const [scenario, setScenario] = useState<Scenario>(getScenario(DEFAULT_SCENARIO_ID));
  const [entering, setEntering] = useState(false);
  const [state, setState] = useState<WorldState | null>(null);
  const [view, setView] = useState<ViewPatch>({});
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  /** 全屏地图层：点对话页左上角的小地图打开 */
  const [mapOpen, setMapOpen] = useState(false);
  const [sfx, setSfx] = useState(soundOn);
  const turnSeq = useRef(0);
  /**
   * 上一回合 facts 的指纹。模块的 facts 是「世界动了」的提示，
   * 但连续做同质动作（比如两次「环顾四周」）会给出完全一样的三行，
   * 重复打印只会让对话流看起来在原地打转——完全相同就跳过。
   */
  const lastFacts = useRef<string>("");
  // 打字机：文本逐字打出。实例只建一次；onTick 触发重绘。
  const [, setTick] = useState(0);
  const twRef = useRef<Typewriter | null>(null);
  const getTw = () => {
    if (!twRef.current) {
      twRef.current = new Typewriter(
        () => ++lineId,
        (line) => setLines((prev) => [...prev, line]),
        () => setTick((v) => v + 1),
      );
    }
    return twRef.current;
  };

  // 全局按键音效（Web Audio 合成，零依赖）；开关由本地状态 + localStorage 记忆
  useEffect(() => installClickSound(), []);

  const push = useCallback((kind: LineKind, text: string) => {
    // 叙事类文本走打字机；玩家的输入和系统提示直接出现（它们不是"剧情"）
    if (kind === "narrative") {
      getTw().enqueue([{ kind, text }]);
      return;
    }
    setLines((prev) => [...prev, { id: ++lineId, kind, text }]);
  }, []);

  // 只读本地记录的房间号，用来决定"继续上次"是否出现
  useEffect(() => {
    try {
      setSavedRoomId(localStorage.getItem(ROOM_KEY) ?? "");
    } catch {
      setSavedRoomId("");
    }
  }, []);

  /**
   * 进入一个已存在的房间：拉权威状态、记下房间号与开局，并把开场剧情铺进对话流。
   * 开场只由前端渲染（不在前端推演世界）；之后玩家输入与叙事接在它下面。
   */
  const enterRoom = useCallback(async (id: string, resumed: boolean) => {
    const snapshot = await fetchState(id);
    let sc = getScenario(DEFAULT_SCENARIO_ID);
    try {
      const stored = localStorage.getItem(scenarioKey(id)) ?? DEFAULT_SCENARIO_ID;
      sc = getScenario(stored);
      localStorage.setItem(ROOM_KEY, id);
      setSavedRoomId(id);
    } catch {
      // 隐私模式读不了本地记录：用默认开局，不影响本局
    }

    // 开场 = 对话流的第一屏：身份 → 正文。建议行动改由输入框上方的快捷按钮给出。
    const tw = getTw();
    tw.reset();
    lastFacts.current = "";
    setLines([]);
    tw.enqueue([
      { kind: "system", text: `序章 · ${sc.name} · ${sc.role}` },
      ...sc.opening.map((text) => ({ kind: "narrative" as LineKind, text })),
      ...(resumed ? [{ kind: "system" as LineKind, text: "（之前的对话不保存；世界状态已从事件日志恢复）" }] : []),
    ]);

    setScenario(sc);
    setState(snapshot);
    setRoomId(id);
    setTab("chat");
    setScreen("game");
  }, []);

  const startNew = useCallback(
    async (scenarioId: string) => {
      setEntering(true);
      setErr("");
      try {
        const id = await createSoloRoom();
        try {
          localStorage.setItem(scenarioKey(id), scenarioId);
        } catch {
          // 隐私模式写不了，退回默认开局，不影响本局
        }
        await enterRoom(id, false);
      } catch (e) {
        setErr(`开局失败：${errorMessage(e)}`);
      } finally {
        setEntering(false);
      }
    },
    [enterRoom],
  );

  const resumeLast = useCallback(async () => {
    if (!savedRoomId) return;
    setEntering(true);
    setErr("");
    try {
      await enterRoom(savedRoomId, true);
    } catch (e) {
      // 房间被清理 / 服务重启后日志丢失：清掉记录，让玩家重新开局
      try {
        localStorage.removeItem(ROOM_KEY);
      } catch {
        // 忽略
      }
      setSavedRoomId("");
      setErr(`上次的房间已不可用（${errorMessage(e)}），请新建一局`);
    } finally {
      setEntering(false);
    }
  }, [enterRoom, savedRoomId]);

  /** 地图操作后重拉 /state；只刷新服务端权威数据，不在前端推演 */
  const refreshState = useCallback(() => {
    if (!roomId) return;
    void fetchState(roomId).then(setState).catch(() => undefined);
  }, [roomId]);

  /**
   * 走到某个点位旁：静默同步世界状态。
   * 不往对话流里 push 文字——走动是连续动作，每一步都刷一行会把剧情冲没。
   */
  const enterScene = useCallback(
    async (locId: string) => {
      if (!roomId) return;
      try {
        await travel(roomId, ACTOR, locId);
        void fetchState(roomId).then(setState).catch(() => undefined);
      } catch {
        // 已经在原地 / 点位未建成：忽略即可，不影响走动
      }
    },
    [roomId],
  );

  /** 发一回合。`raw` 用于快捷建议：点一下就等于把这句话说出来，不必先填进输入框。 */
  const send = useCallback(async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy || !roomId) return;
    const tw = getTw();
    // 玩家急着说下一句：先把手上的字放完（包括上一回合还没打完的叙事）
    if (tw.typing) tw.skip();
    setBusy(true);
    setErr("");
    setInput("");
    push("player", text);
    const clientTurnId = `${Date.now()}_${++turnSeq.current}`;
    tw.setTurnEnded(false);
    try {
      await runTurn(roomId, ACTOR, text, clientTurnId, {
        onDelta: (field, chunk) => {
          if (field !== "narrative") return;
          tw.feed(chunk);
        },
        // 模块的 facts 是玩家唯一能"看见世界动了"的地方（Mock 模式下尤其重要）
        onFacts: (facts) => {
          const rows = facts.filter((f) => f.trim().length > 0);
          if (rows.length === 0) return;
          const key = rows.join("\n");
          if (key === lastFacts.current) return; // 与上一回合完全相同：不再重复刷屏
          lastFacts.current = key;
          tw.enqueue(rows.map((f) => ({ kind: "fact" as LineKind, text: f })));
        },
        onPatch: (s) => setState(s),
        onUi: (v) => setView((old) => ({ ...old, ...v })),
        onError: (code, message) => setErr(`${code}: ${message}`),
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      tw.setTurnEnded(true);
      setBusy(false);
      void fetchState(roomId).then(setState).catch(() => undefined);
    }
  }, [busy, input, push, roomId]);

  if (screen === "title") {
    return (
      <TitleScreen
        scenarios={SCENARIOS}
        onStart={(scenarioId) => void startNew(scenarioId)}
        onResume={savedRoomId ? () => void resumeLast() : null}
        savedRoomId={savedRoomId}
        busy={entering}
        err={err}
      />
    );
  }

  const panels = view.panels ?? {};
  const pos = view.position;
  const typing = getTw().activeLine;
  /**
   * 开场白打完了吗？建议按钮要等逐字动画收尾后再出现，
   * 否则字还没打出来、按钮先摆在那儿，剧情的节奏就断了。
   * 玩家点一下日志跳过打字时 typing 也会立刻变 false，按钮随即出现。
   */
  const sceneSettled = !getTw().typing;
  /** 已经进行到第几回合（玩家开口次数） */
  const playedTurns = lines.filter((l) => l.kind === "player").length;
  /** 下一步能干什么：开局给剧本建议，之后按当前场景推导（出口 + 在场的人） */
  const nextActions = playedTurns === 0 ? scenario.suggestions : turnSuggestions(pos, playedTurns);

  return (
    <div className="app screen-in">
      <header className="topbar">
        <div className="brand">
          <h1>ECUST · AI 校园</h1>
          <span className="muted">{roomId ? `${scenario.name} · room ${roomId}` : "连接中…"}</span>
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
        <button
          type="button"
          className="btn ghost back-title"
          onClick={() => {
            // 回标题时清掉局内报错、放完正在打的字并停表，别把上一局的错误/定时器带到入口页
            getTw().skip();
            getTw().stop();
            setErr("");
            setScreen("title");
          }}
        >
          ← 标题
        </button>
        <button
          type="button"
          className={`btn ghost sfx-toggle${sfx ? "" : " off"}`}
          onClick={() => {
            const next = !sfx;
            setSoundOn(next);
            setSfx(next);
          }}
          title={sfx ? "点击静音" : "点击开启音效"}
        >
          {sfx ? "♪" : "静音"}
        </button>
        <div className="muted clock">
          {state ? `第 ${state.clock.day} 天 · ${phaseLabel(state.clock.phase)}` : ""}
        </div>
      </header>

      <div className="app-body">
        <div className="tab-pane" key={tab}>
        {tab === "gallery" && <GalleryPanel state={state} />}

        {tab === "chat" && (
          <ChatPanel
            state={state}
            panels={panels}
            pos={pos}
            lines={lines}
            typing={typing}
            busy={busy}
            err={err}
            input={input}
            onInput={setInput}
            onSend={() => void send()}
            // 每回合结束（字打完、且不在等回复）都给建议；等回复时先收起，免得发旧选项
            suggestions={!busy && sceneSettled ? nextActions : []}
            onPick={(text) => void send(text)}
            roomId={roomId}
            onOpenMap={() => setMapOpen(true)}
            heroId={scenario.id}
            onEnterScene={(locId) => void enterScene(locId)}
            onSkipLog={() => getTw().skip()}
          />
        )}

        {tab === "drafts" &&
          (roomId ? (
            <DraftsPanel roomId={roomId} push={push} onRefreshState={refreshState} />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}
        </div>
      </div>

      {/* 地图不再是独立标签页：从对话页左上角的小地图展开，选完地点自动回到对话 */}
      {roomId && (
        <MapOverlay
          open={mapOpen}
          onClose={() => setMapOpen(false)}
          roomId={roomId}
          actorId={ACTOR}
          push={push}
          onRefreshState={refreshState}
        />
      )}
    </div>
  );
}
