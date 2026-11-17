/**
 * 2D 场景：一个俯视角的小世界。
 *
 * - 你是一个能 WASD 走的小人（脚在坐标点上，身体向上长）；
 * - 在场的 NPC 摆成可点击的小人，头顶有名字；
 * - 走近 NPC 时他脚下会亮起提示，点一下就打开对话；现场有出口时底部有门牌，点了就走。
 *
 * 表现层完全本地：走动不改世界状态（世界状态只由服务端裁决），
 * 换地点走 /map/travel，说话走回合接口 —— 所以这里没有"客户端推演"。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewPatch } from "../../../packages/shared/src/contract/types.ts";

const W = 960;
const H = 540;
const SPEED = 235;
const HERO_W = 44;
const HERO_H = 62;
const NPC_W = 40;
const NPC_H = 58;
const NEAR_DIST = 92;

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export interface World2DProps {
  pos: ViewPatch["position"];
  /** 当前正在对话的 NPC（高亮 + 面向） */
  talkingTo: string;
  busy: boolean;
  onTalk: (actorId: string, name: string) => void;
  onTravel: (locId: string) => void;
}

interface NpcSlot {
  actorId: string;
  name: string;
  x: number;
  y: number;
}

export default function World2D({ pos, talkingTo, busy, onTalk, onTravel }: World2DProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [near, setNear] = useState<{ id: string; name: string } | null>(null);

  // 逻辑坐标 → 实际像素：整张舞台按容器宽度等比缩放
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setScale(Math.min(el.clientWidth / W, el.clientHeight / H));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // NPC 站位：按人数均分在中上部，单双数错开高度，避免挤成一排
  const npcs = useMemo<NpcSlot[]>(() => {
    const list = (pos?.actors ?? []).filter((a) => a.present && a.actorId !== "plr_self");
    const n = list.length;
    return list.map((a, i) => {
      const t = n <= 1 ? 0.5 : i / (n - 1);
      return {
        actorId: a.actorId,
        name: a.name,
        x: 210 + t * 540,
        y: i % 2 === 0 ? 268 : 316,
      };
    });
  }, [pos?.actors]);

  const npcRef = useRef(npcs);
  npcRef.current = npcs;
  const nearRef = useRef<string | null>(null);
  const posRef = useRef({ x: W / 2, y: 452 });
  const lastLocRef = useRef("");

  // 换地点 = 换房间：把主角放回门口
  const locId = pos?.locId ?? "";
  if (locId !== lastLocRef.current) {
    lastLocRef.current = locId;
    posRef.current = { x: W / 2, y: H - 78 };
  }

  // 键盘 + 每帧推进（直接改 transform，不走 React 重渲染）
  useEffect(() => {
    const keys = new Set<string>();
    let facing = 1;

    const onDown = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS.has(k)) return;
      keys.add(k);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      keys.delete(e.key.toLowerCase());
    };
    const onBlur = () => keys.clear();

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);

    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      let vx = 0;
      let vy = 0;
      if (keys.has("a") || keys.has("arrowleft")) vx -= 1;
      if (keys.has("d") || keys.has("arrowright")) vx += 1;
      if (keys.has("w") || keys.has("arrowup")) vy -= 1;
      if (keys.has("s") || keys.has("arrowdown")) vy += 1;

      const moving = vx !== 0 || vy !== 0;
      if (moving) {
        const len = Math.hypot(vx, vy);
        const p = posRef.current;
        p.x = Math.max(38, Math.min(W - 38, p.x + (vx / len) * SPEED * dt));
        p.y = Math.max(150, Math.min(H - 48, p.y + (vy / len) * SPEED * dt));
        if (vx !== 0) facing = vx > 0 ? 1 : -1;
      }

      const hero = heroRef.current;
      if (hero) {
        const p = posRef.current;
        hero.style.transform = `translate3d(${p.x - HERO_W / 2}px, ${p.y - HERO_H}px, 0) scaleX(${facing})`;
        hero.classList.toggle("walking", moving);
      }

      // 最近的可交谈对象：只在变化时 setState，避免每帧重渲染
      let closest: { id: string; name: string } | null = null;
      let best = NEAR_DIST;
      const p = posRef.current;
      for (const n of npcRef.current) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < best) {
          best = d;
          closest = { id: n.actorId, name: n.name };
        }
      }
      const key = closest?.id ?? null;
      if (key !== nearRef.current) {
        nearRef.current = key;
        setNear(closest);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const exits = pos?.exits ?? [];

  return (
    <div className="world2d" ref={wrapRef}>
      <div
        className="world2d-stage"
        style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <div className="world2d-floor" />
        <div className="world2d-grid" />

        {/* 远景剪影，给场景一点纵深 */}
        <div className="world2d-backdrop">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} style={{ height: `${70 + (i % 3) * 34}px` }} />
          ))}
        </div>

        {npcs.map((n) => {
          const hue = hueOf(n.actorId);
          const isNear = near?.id === n.actorId;
          const isTalking = talkingTo === n.actorId;
          return (
            <button
              type="button"
              key={n.actorId}
              className={`npc-sprite${isNear ? " near" : ""}${isTalking ? " talking" : ""}`}
              style={{
                transform: `translate3d(${n.x - NPC_W / 2}px, ${n.y - NPC_H}px, 0)`,
                width: NPC_W,
                height: NPC_H,
              }}
              onClick={() => onTalk(n.actorId, n.name)}
              disabled={busy}
              title={`和${n.name}说话`}
            >
              <span className="sprite-name">{n.name}</span>
              <span className="sprite-body" style={{ background: `hsl(${hue} 40% 34%)`, borderColor: `hsl(${hue} 55% 50%)` }}>
                <i className="sprite-head" style={{ background: `hsl(${hue} 45% 72%)` }} />
              </span>
              <span className="sprite-shadow" />
              {isNear && <span className="sprite-prompt">交谈</span>}
            </button>
          );
        })}

        <div
          ref={heroRef}
          className="hero-sprite"
          style={{
            width: HERO_W,
            height: HERO_H,
            transform: `translate3d(${posRef.current.x - HERO_W / 2}px, ${posRef.current.y - HERO_H}px, 0)`,
          }}
        >
          <span className="hero-body">
            <i className="hero-head" />
          </span>
          <span className="sprite-shadow" />
        </div>

        {exits.length > 0 && (
          <div className="world2d-exits">
            {exits.map((e) => (
              <button
                type="button"
                key={e.locId}
                className="exit-door"
                onClick={() => onTravel(e.locId)}
                disabled={busy}
                title={`前往${e.name}`}
              >
                <span className="exit-icon">门</span>
                <span>{e.name}</span>
              </button>
            ))}
          </div>
        )}

        {near && !talkingTo && <div className="world2d-tip">点击 {near.name}，和他说话</div>}
      </div>
    </div>
  );
}
