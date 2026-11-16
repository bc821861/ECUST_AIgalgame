import { useCallback, useEffect, useState } from "react";
import { getMap, openDialogue, tick, travel } from "./api.ts";
import type { MapScene, MapView } from "./api.ts";
import SceneDetail from "./SceneDetail.tsx";
import { errorMessage, phaseLabel, sceneName } from "./ui.ts";
import type { LineKind } from "./ui.ts";

interface Props {
  roomId: string;
  actorId: string;
  push: (kind: LineKind, text: string) => void;
  /** travel/tick 后让 App 重拉 /state（只刷新，不缓存权威状态） */
  onRefreshState: () => void;
}

type Busy = "load" | "travel" | "tick" | "dialogue" | null;

/**
 * tick.moved 按 server-api 对齐的形状解析：`{actorId, name, from, to}` 的数组
 * （from/to 是 locId）。仍做防御解析，形状漂移时最多少显示摘要，不崩。
 */
function summarizeMoved(moved: unknown, map: MapView): string[] {
  if (!Array.isArray(moved) || moved.length === 0) return [];
  const sceneOf = (id: string) => map.scenes.find((s) => s.id === id)?.name ?? id;
  const out: string[] = [];
  for (const item of moved) {
    if (out.length >= 8) break;
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const actorId = typeof rec.actorId === "string" ? rec.actorId : "";
    const who =
      (typeof rec.name === "string" && rec.name) ||
      map.npcs.find((n) => n.id === actorId)?.name ||
      actorId;
    if (!who) continue;
    const from = typeof rec.from === "string" ? rec.from : "";
    const to = typeof rec.to === "string" ? rec.to : "";
    if (from && to) out.push(`${who} 从${sceneOf(from)}去了${sceneOf(to)}`);
    else if (to) out.push(`${who} 去了${sceneOf(to)}`);
    else out.push(`${who} 移动了`);
  }
  return out;
}

export default function MapPanel({ roomId, actorId, push, onRefreshState }: Props) {
  const [map, setMap] = useState<MapView | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState("");

  const applyMap = useCallback((next: MapView) => {
    setMap(next);
    setSelectedId((prev) => (next.scenes.some((s) => s.id === prev) ? prev : next.player.locId));
  }, []);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      applyMap(await getMap(roomId));
      setErr("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [applyMap, roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  const go = useCallback(
    async (scene: MapScene) => {
      setSelectedId(scene.id);
      if (!map || scene.id === map.player.locId) return;
      setBusy("travel");
      setErr("");
      try {
        const res = await travel(roomId, actorId, scene.id);
        applyMap(res.map);
        setSelectedId(scene.id);
        if (res.map.player.locId === scene.id) {
          push("narrative", `【${res.scene.name}】${res.scene.desc}`);
        } else {
          setErr("没有到达该场景");
        }
        onRefreshState();
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [actorId, applyMap, map, onRefreshState, push, roomId],
  );

  const advance = useCallback(async () => {
    setBusy("tick");
    setErr("");
    try {
      const res = await tick(roomId, true);
      applyMap(res.map);
      const moves = summarizeMoved(res.moved, res.map);
      const head = `【时段推进】第 ${res.map.clock.day} 天 · ${phaseLabel(res.map.clock.phase)}`;
      push("system", moves.length ? `${head}。${moves.join("；")}` : `${head}。没有人移动。`);
      onRefreshState();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [applyMap, onRefreshState, push, roomId]);

  const talk = useCallback(
    async (scene: MapScene, dialogueId: string) => {
      setBusy("dialogue");
      setErr("");
      try {
        const res = await openDialogue(roomId, actorId, scene.id, dialogueId);
        for (const line of res.lines) push("npc", `${res.npc.name}：${line}`);
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [actorId, push, roomId],
  );

  if (!map) {
    return (
      <div className="panel-note">
        <div className="muted">{busy === "load" ? "加载地图…" : "地图尚未加载"}</div>
        {err && <div className="err">{err}</div>}
        <button className="btn" onClick={() => void load()} disabled={busy !== null}>
          重试
        </button>
      </div>
    );
  }

  const selected = map.scenes.find((s) => s.id === selectedId) ?? null;
  return (
    <div className="map-panel">
      <div className="map-stage">
        <div className="map-toolbar">
          <div>
            <strong>第 {map.clock.day} 天</strong>
            <span className="muted"> · {phaseLabel(map.clock.phase)}</span>
            <span className="muted"> · 你在{sceneName(map.scenes, map.player.locId)}</span>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void advance()} disabled={busy !== null}>
              推进时段
            </button>
            <button className="btn ghost" onClick={() => void load()} disabled={busy !== null}>
              刷新
            </button>
          </div>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="map-scroll">
          <div className="map-canvas" style={{ width: map.width || 1000, height: map.height || 640 }}>
            {map.npcs.map((npc) => (
              <span key={npc.id} className="map-npc" style={{ left: npc.x, top: npc.y }} title={npc.name} />
            ))}
            {map.scenes.map((scene) => {
              const present = scene.presentNpcIds
                .map((id) => map.npcs.find((n) => n.id === id)?.name)
                .filter((name): name is string => Boolean(name));
              const classes = [
                "map-scene",
                scene.id === map.player.locId ? "current" : "",
                scene.id === selectedId ? "selected" : "",
                scene.installed ? "" : "uninstalled",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={scene.id}
                  type="button"
                  className={classes}
                  style={{ left: scene.x, top: scene.y }}
                  title={`${scene.name}（${scene.x}, ${scene.y}）`}
                  onClick={() => void go(scene)}
                  disabled={busy !== null}
                >
                  <span className="map-scene-name">{scene.name}</span>
                  {present.length > 0 && <span className="map-scene-sub">{present.join("、")}</span>}
                  {scene.id === map.player.locId && <span className="map-you">你</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {selected ? (
        <SceneDetail
          scene={selected}
          map={map}
          busy={busy !== null}
          onTravel={(scene) => void go(scene)}
          onDialogue={(dialogueId) => void talk(selected, dialogueId)}
        />
      ) : (
        <aside className="map-detail">
          <div className="muted">选择场景查看详情。</div>
        </aside>
      )}
    </div>
  );
}
