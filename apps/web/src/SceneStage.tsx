/**
 * 场景舞台：对话页顶部的"画面"。
 *
 * 我们现在还没有立绘资源，所以这一层用**纯几何**做：
 * 每个地点一套配色 + 一个简笔剪影（书架 / 长桌 / 跑道 / 窗格 / 门），
 * 右上是当前在场的人（圆形头像位，用姓名首字占位）。
 *
 * 它的作用不是"好看"，而是把纯文字页变成有**空间感**的界面：
 * 你随时知道自己在哪、身边有谁——这两件事以前只能从下面那行小字里读。
 *
 * 等立绘到位，只需把 <SceneArt> 换成 <img>，其余布局不动。
 */
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import MiniMap from "./MiniMap.tsx";
import { phaseLabel } from "./ui.ts";

interface SceneSkin {
  from: string;
  to: string;
  accent: string;
  /** 简笔剪影：只画最能认出来的几笔 */
  art: "books" | "table" | "track" | "windows" | "door" | "none";
}

const SKINS: Record<string, SceneSkin> = {
  loc_library: { from: "#141d33", to: "#243a5e", accent: "#7fa6ff", art: "books" },
  loc_canteen: { from: "#2a1a12", to: "#4a2f1a", accent: "#ffb56b", art: "table" },
  loc_playground: { from: "#0f2620", to: "#1b3a2f", accent: "#6fe0b0", art: "track" },
  loc_teaching_1: { from: "#171a24", to: "#2b3040", accent: "#9fb4e0", art: "windows" },
  loc_dorm3: { from: "#1e1526", to: "#352343", accent: "#c39bff", art: "door" },
};

const FALLBACK: SceneSkin = { from: "#15171f", to: "#232838", accent: "#8b93a7", art: "none" };

/** 首字取姓名最后一个字更"像外号"，但这里保持简单：取第一个字 */
function initial(name: string): string {
  return name.trim().slice(0, 1) || "?";
}

/** 用 id 做稳定色相：同一个人每一局颜色一致，方便记 */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function SceneArt({ art }: { art: SceneSkin["art"] }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const };
  switch (art) {
    case "books":
      return (
        <svg viewBox="0 0 240 80" aria-hidden="true" className="scene-art">
          {[0, 1, 2].map((i) => (
            <g key={i} {...common} opacity={0.55 - i * 0.12}>
              <line x1={30 + i * 66} y1="14" x2={30 + i * 66} y2="66" />
              <line x1={30 + i * 66} y1="26" x2={66 + i * 66} y2="26" />
              <line x1={30 + i * 66} y1="46" x2={66 + i * 66} y2="46" />
            </g>
          ))}
        </svg>
      );
    case "table":
      return (
        <svg viewBox="0 0 240 80" aria-hidden="true" className="scene-art">
          <g {...common} opacity="0.5">
            <ellipse cx="120" cy="34" rx="58" ry="15" />
            <line x1="86" y1="46" x2="80" y2="68" />
            <line x1="154" y1="46" x2="160" y2="68" />
            {[70, 170].map((x) => (
              <line key={x} x1={x} y1="60" x2={x} y2="72" />
            ))}
          </g>
        </svg>
      );
    case "track":
      return (
        <svg viewBox="0 0 240 80" aria-hidden="true" className="scene-art">
          <g {...common} opacity="0.5">
            {[0, 1, 2].map((i) => (
              <path key={i} d={`M20 ${58 + i * 6} Q120 ${18 + i * 8} 220 ${58 + i * 6}`} />
            ))}
          </g>
        </svg>
      );
    case "windows":
      return (
        <svg viewBox="0 0 240 80" aria-hidden="true" className="scene-art">
          <g {...common} opacity="0.45">
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} x={30 + i * 50} y="18" width="30" height="34" rx="2" />
            ))}
          </g>
        </svg>
      );
    case "door":
      return (
        <svg viewBox="0 0 240 80" aria-hidden="true" className="scene-art">
          <g {...common} opacity="0.5">
            <rect x="100" y="16" width="40" height="50" rx="3" />
            <circle cx="132" cy="42" r="1.8" />
            <line x1="60" y1="66" x2="180" y2="66" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

export interface SceneStageProps {
  pos: ViewPatch["position"];
  state: WorldState | null;
  /** 有房间号才加载小地图 */
  roomId: string;
  /** 点小地图：打开全屏地图选点 */
  onOpenMap: () => void;
}

export default function SceneStage({ pos, state, roomId, onOpenMap }: SceneStageProps) {
  const locId = pos?.locId ?? "";
  const skin = SKINS[locId] ?? FALLBACK;
  const present = (pos?.actors ?? []).filter((a) => a.present && a.actorId !== "plr_self");
  const day = state?.clock.day ?? 1;
  const phase = state ? phaseLabel(state.clock.phase) : "—";

  return (
    <div
      className="scene-stage"
      style={{ background: `linear-gradient(160deg, ${skin.from}, ${skin.to})`, color: skin.accent }}
    >
      <div className="scene-glow" style={{ background: `radial-gradient(circle at 22% 30%, ${skin.accent}33, transparent 62%)` }} />

      {roomId && <MiniMap roomId={roomId} onOpen={onOpenMap} />}

      <div className="scene-copy">
        <div className="scene-where">
          <span className="scene-name">{pos?.name ?? "未知地点"}</span>
          <span className="scene-time">
            第 {day} 天 · {phase}
          </span>
        </div>
        <div className="scene-exits">
          {pos && pos.exits.length > 0 ? (
            <>出口：{pos.exits.map((e) => e.name).join(" · ")}</>
          ) : (
            <>这里暂时没有可走的路</>
          )}
        </div>
      </div>

      <div className="scene-art-wrap">
        <SceneArt art={skin.art} />
      </div>

      <div className="scene-cast">
        {present.length === 0 && <span className="scene-empty">只有你</span>}
        {present.map((a) => (
          <div className="cast-chip" key={a.actorId} title={`${a.name}就在这儿`}>
            <span className="cast-face" style={{ background: `hsl(${hueOf(a.actorId)} 42% 26%)`, color: `hsl(${hueOf(a.actorId)} 70% 82%)` }}>
              {initial(a.name)}
            </span>
            <span className="cast-name">{a.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
