/**
 * 校园大地图：直接在奉贤校区的底图上走。
 *
 * - 底图是 6000×4500 的实拍鸟瞰，所有坐标都用这张图自己的像素系；
 * - 主角是抠过背景的立绘 PNG，站在地图上（不随缩放变形，固定显示尺寸）；
 * - 33 个场景点位散布在图上，走近就"到达"（静默同步世界状态，不往对话流里刷字）；
 * - NPC 按 located_in 的位置摆成头像标记，走近可点，点了就开始对话。
 *
 * 渲染方式：整张世界放在一个等比缩放的容器里，每帧只改容器的 translate，
 * 所以相机移动是一层 CSS 变换，不是 33 个元素各自重排。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapScene, MapView } from "./api.ts";
import { NPC_PROFILES } from "./scenarios.ts";

const W = 6000;
const H = 4500;
const SCALE = 0.42;
const SPEED = 300;
const ENTER_DIST = 170;
const TALK_DIST = 140;

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface CampusMapProps {
  map: MapView | null;
  heroSrc: string;
  talkingTo: string;
  busy: boolean;
  onTalk: (actorId: string, name: string) => void;
  /** 走到某个点位旁：交给上层静默同步世界状态 */
  onEnter: (sceneId: string) => void;
}

export default function CampusMap({ map, heroSrc, talkingTo, busy, onTalk, onEnter }: CampusMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [nearScene, setNearScene] = useState<MapScene | null>(null);
  const [nearNpc, setNearNpc] = useState<{ id: string; name: string } | null>(null);

  const posRef = useRef<{ x: number; y: number } | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  const nearSceneRef = useRef<string>("");
  const nearNpcRef = useRef<string>("");
  const enteredRef = useRef<string>("");
  const startRef = useRef("");
  /** 相机位置跨重渲染保留：地图数据刷新不应让镜头跳回左上角 */
  const camRef = useRef({ x: 0, y: 0 });
  /** 循环里读最新的地图，避免每次 map 更新都重启 rAF */
  const mapRef = useRef<MapView | null>(null);
  mapRef.current = map;

  const scenes = map?.scenes ?? [];
  const npcs = map?.npcs ?? [];

  // 出生点：当前 locId 对应的点位；找不到就放图中央
  const spawn = useMemo(() => {
    const here = scenes.find((s) => s.id === map?.player.locId);
    if (here) return { x: here.x, y: here.y };
    return { x: W / 2, y: H / 2 };
  }, [map?.player.locId, scenes]);

  useEffect(() => {
    if (!map || posRef.current) return;
    posRef.current = { ...spawn };
    setReady(true);
  }, [map, spawn]);

  // 换房间（比如用地图层传送）时把主角挪到新点位
  useEffect(() => {
    if (!map) return;
    const here = map.scenes.find((s) => s.id === map.player.locId);
    if (!here) return;
    if (startRef.current === here.id) return;
    startRef.current = here.id;
    if (posRef.current && Math.hypot(posRef.current.x - here.x, posRef.current.y - here.y) > 320) {
      posRef.current = { x: here.x, y: here.y };
      enteredRef.current = here.id;
    }
  }, [map]);

  /**
   * 键盘监听只绑一次。
   * 之前它和主循环写在同一个 effect 里、依赖 [onEnter]——父组件每次重渲染都会换一个新的
   * onEnter 函数引用，effect 于是不停重建，手上按着的键被清空，人就"走不动"了。
   */
  useEffect(() => {
    const keys = keysRef.current;
    const onDown = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS.has(k)) return;
      keys.add(k);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const onBlur = () => keys.clear();

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 主循环：只依赖 ready；地图数据、回调都从 ref 读，避免被父组件的重渲染反复打断
  useEffect(() => {
    if (!ready) return;
    const keys = keysRef.current;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const p = posRef.current;
      const vp = viewportRef.current;
      const live = mapRef.current;
      if (p && vp && live) {
        const sceneList = live.scenes.filter((s) => s.status === "built");
        const npcList = live.npcs;
        let vx = 0;
        let vy = 0;
        if (keys.has("a") || keys.has("arrowleft")) vx -= 1;
        if (keys.has("d") || keys.has("arrowright")) vx += 1;
        if (keys.has("w") || keys.has("arrowup")) vy -= 1;
        if (keys.has("s") || keys.has("arrowdown")) vy += 1;
        if (vx !== 0 || vy !== 0) {
          const len = Math.hypot(vx, vy);
          p.x = clamp(p.x + (vx / len) * SPEED * dt, 40, W - 40);
          p.y = clamp(p.y + (vy / len) * SPEED * dt, 40, H - 40);
        }

        const vw = vp.clientWidth;
        const vh = vp.clientHeight;
        const viewW = vw / SCALE;
        const viewH = vh / SCALE;
        const cam = camRef.current;
        const targetX = clamp(p.x - viewW / 2, 0, Math.max(0, W - viewW));
        const targetY = clamp(p.y - viewH / 2, 0, Math.max(0, H - viewH));
        cam.x += (targetX - cam.x) * 0.22;
        cam.y += (targetY - cam.y) * 0.22;

        const world = worldRef.current;
        if (world) world.style.transform = `translate3d(${-cam.x * SCALE}px, ${-cam.y * SCALE}px, 0)`;
        const hero = heroRef.current;
        if (hero) hero.style.transform = `translate3d(${p.x * SCALE}px, ${p.y * SCALE}px, 0)`;

        // 最近的可进入点位
        let bestScene: MapScene | null = null;
        let bestD = ENTER_DIST;
        for (const s of sceneList) {
          const d = Math.hypot(s.x - p.x, s.y - p.y);
          if (d < bestD) {
            bestD = d;
            bestScene = s;
          }
        }
        const sceneKey = bestScene?.id ?? "";
        if (sceneKey !== nearSceneRef.current) {
          nearSceneRef.current = sceneKey;
          setNearScene(bestScene);
          if (bestScene && bestScene.id !== live.player.locId && enteredRef.current !== bestScene.id) {
            enteredRef.current = bestScene.id;
            onEnterRef.current(bestScene.id);
          }
          if (!bestScene) enteredRef.current = "";
        }

        // 最近的可交谈 NPC
        let bestNpc: { id: string; name: string } | null = null;
        let bestNpcD = TALK_DIST;
        for (const n of npcList) {
          const d = Math.hypot(n.x - p.x, n.y - p.y);
          if (d < bestNpcD) {
            bestNpcD = d;
            bestNpc = { id: n.id, name: n.name };
          }
        }
        const npcKey = bestNpc?.id ?? "";
        if (npcKey !== nearNpcRef.current) {
          nearNpcRef.current = npcKey;
          setNearNpc(bestNpc);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [ready]);

  if (!map) {
    return (
      <div className="campus-loading">
        <span>正在加载校园地图…</span>
      </div>
    );
  }

  return (
    <div
      className="campus"
      ref={viewportRef}
      // 点场景 = 把焦点从输入框挪开；否则 WASD 会被当成打字，人自然"走不动"
      onClick={() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el !== document.body) el.blur();
      }}
    >
      <div className="campus-world" ref={worldRef} style={{ width: W * SCALE, height: H * SCALE }}>
        <div
          className="campus-ground"
          style={{ backgroundImage: `url(${map.image ?? "/map/ecust-campus.jpg"})` }}
        />

        {map.scenes.map((s) => {
          const built = s.status === "built";
          const isNear = nearScene?.id === s.id;
          return (
            <button
              type="button"
              key={s.id}
              className={`campus-poi${built ? "" : " planned"}${isNear ? " near" : ""}`}
              style={{ left: s.x * SCALE, top: s.y * SCALE }}
              title={built ? s.name : `${s.name}（${s.status === "planned" ? "规划中" : "在建"}）`}
              onClick={() => built && onEnter(s.id)}
            >
              <i />
              <span>{s.name}</span>
            </button>
          );
        })}

        {map.npcs.map((n) => {
          const isNear = nearNpc?.id === n.id;
          const isTalking = talkingTo === n.id;
          const mutter = NPC_PROFILES[n.id]?.mutter;
          return (
            <button
              type="button"
              key={n.id}
              className={`campus-npc${isNear ? " near" : ""}${isTalking ? " talking" : ""}`}
              style={{ left: n.x * SCALE, top: n.y * SCALE }}
              onClick={() => onTalk(n.id, n.name)}
              disabled={busy}
              title={`和${n.name}说话`}
            >
              {/* 走近时头顶浮一句短台词：只提示"可以聊"，不打断你走路 */}
              {isNear && !talkingTo && mutter && <span className="campus-mutter">{mutter}</span>}
              <img src={`/portraits/${n.id}.jpg`} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
              <span className="npc-name">{n.name}</span>
            </button>
          );
        })}

        <div className="campus-hero" ref={heroRef}>
          <img src={heroSrc} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
        </div>
      </div>

      <div className="campus-controls">
        <span className="campus-key">W</span>
        <span className="campus-key">A</span>
        <span className="campus-key">S</span>
        <span className="campus-key">D</span>
        <span className="campus-hint">走动</span>
      </div>

      {nearScene && (
        <div className="campus-tip">
          <strong>{nearScene.name}</strong>
          <span>
            {nearScene.id === map.player.locId
              ? "你就在这里"
              : nearScene.status === "built"
                ? "走近即到达"
                : "尚未开放"}
          </span>
        </div>
      )}
    </div>
  );
}