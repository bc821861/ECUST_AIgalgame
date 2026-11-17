/**
 * 图鉴页：这一局里你"认识"的人，以及你对他们的读数。
 * 只读 WorldState；未见面的人不显示名字与数值（图鉴的乐趣就在解锁）。
 * 戒备（guard）在注册表里是 secret，所以只给分档，不给精确值——这是有意的。
 */
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import { NPC_PROFILES } from "./scenarios.ts";

interface Card {
  id: string;
  name: string;
  met: boolean;
  trust?: number;
  guard?: number;
  mood?: string;
  locName: string;
  present: boolean;
  role: string;
  traits: string[];
  line: string;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function guardBand(g: number | undefined): { label: string; cls: string } {
  if (g === undefined) return { label: "—", cls: "" };
  if (g <= 33) return { label: "放松", cls: "calm" };
  if (g <= 66) return { label: "警惕", cls: "wary" };
  return { label: "戒备森严", cls: "tense" };
}

export default function GalleryPanel({ state }: { state: WorldState | null }) {
  if (!state) {
    return (
      <div className="panel-note">
        <div className="muted">正在读取世界状态…</div>
      </div>
    );
  }

  const playerLoc = state.room.scene.locId;
  const presentIds = new Set(state.room.scene.presentIds);

  /** NPC 的位置：located_in 边的 to（引擎投影，不猜） */
  const locOf = (npcId: string): string => {
    const link = state.links.find((l) => l.kind === "located_in" && l.from === npcId);
    return link?.to ?? "";
  };

  const cards: Card[] = Object.values(state.entities)
    .filter((e) => e.kind === "npc" && e.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const loc = locOf(e.id);
      const present = presentIds.has(e.id);
      const profile = NPC_PROFILES[e.id];
      const sameLoc = loc !== "" && loc === playerLoc;
      return {
        id: e.id,
        name: e.name,
        met: present || sameLoc,
        trust: num(e.attrs.trust),
        guard: num(e.attrs.guard),
        mood: typeof e.attrs.mood === "string" ? e.attrs.mood : undefined,
        locName: loc ? state.entities[loc]?.name ?? loc : "",
        present,
        role: profile?.role ?? "身份不明",
        traits: profile?.traits ?? [],
        line: profile?.line ?? "",
      };
    });

  const metCount = cards.filter((c) => c.met).length;
  const allLocs = Object.values(state.entities).filter((e) => e.kind === "loc");
  const visited = allLocs.length;

  return (
    <div className="gallery-panel">
      <div className="gallery-head">
        <div>
          <strong>人物图鉴</strong>
          <span className="muted">
            {" "}
            · 已遇见 {metCount}/{cards.length} · 校园地点 {visited}
          </span>
        </div>
        <span className="muted">遇到人（或和他同处一地）才会解锁；数值随互动变化</span>
      </div>

      <div className="gallery-grid">
        {cards.map((c) => {
          const band = guardBand(c.guard);
          const trust = c.trust ?? 0;
          return (
            <article key={c.id} className={`npc-card${c.met ? "" : " locked"}`}>
              <header>
                <h3>{c.met ? c.name : "？？？"}</h3>
                <span className={`pill ${c.present ? "published" : "approved"}`}>
                  {c.present ? "在场" : c.met ? "在别处" : "未见面"}
                </span>
              </header>
              <div className="muted">{c.met ? c.role : "还没见过这个人"}</div>

              {c.met ? (
                <>
                  {c.traits.length > 0 && (
                    <div className="chips">
                      {c.traits.map((t) => (
                        <span className="chip tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="stat">
                    <span className="stat-label">信任</span>
                    <div className="bar">
                      <i style={{ width: `${Math.max(0, Math.min(100, trust))}%` }} />
                    </div>
                    <span className="stat-num">{c.trust ?? "—"}</span>
                  </div>

                  <div className="stat">
                    <span className="stat-label">戒备</span>
                    <span className={`chip guard ${band.cls}`}>{band.label}</span>
                    <span className="stat-num muted">体感</span>
                  </div>

                  <div className="row">
                    <dt>位置</dt>
                    <dd>{c.present ? "就在你身边" : c.locName || "行踪不明"}</dd>
                  </div>
                  {c.mood && (
                    <div className="row">
                      <dt>情绪</dt>
                      <dd>{c.mood}</dd>
                    </div>
                  )}
                  {c.line && <p className="npc-line">「{c.line}」</p>}
                </>
              ) : (
                <p className="muted npc-line">在校园里遇到他，这一页才会写下名字。</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
