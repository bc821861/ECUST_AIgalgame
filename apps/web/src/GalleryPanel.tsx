/**
 * 图鉴页：这一局里你"认识"的人，以及你对他们的读数。
 *
 * 属性一律按 `/api/v1/registry` 的声明渲染（I2）：不在前端写死任何属性键。
 * - `public`/`self` 的数值属性 → 标签 + 数值 + 进度条；
 * - `secret` 的数值属性 → 只给三档体感（低/中/高），不给精确值；
 * - 非数值属性 → 文本行；未写入的属性不显示（建房只播 public，其余由玩法写入）。
 */
import { useEffect, useState } from "react";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import { getRegistry } from "./api-registry.ts";
import type { AttrDecl } from "./api-registry.ts";
import { NPC_PROFILES } from "./scenarios.ts";

interface AttrRow {
  key: string;
  label: string;
  unit?: string;
  secret: boolean;
  text?: string;
  value?: number;
  ratio?: number;
  band?: { label: string; cls: string };
}

function bandOf(value: number, min: number, max: number): { label: string; cls: string } {
  const span = max - min || 1;
  const t = (value - min) / span;
  if (t <= 1 / 3) return { label: "低", cls: "calm" };
  if (t <= 2 / 3) return { label: "中", cls: "wary" };
  return { label: "高", cls: "tense" };
}

/** 把某实体的属性按注册表声明摊平成可渲染行 */
function rowsOf(e: WorldState["entities"][string], decls: AttrDecl[]): AttrRow[] {
  const rows: AttrRow[] = [];
  for (const def of decls) {
    if (def.hidden || !def.scope.includes(e.kind)) continue;
    const value = e.attrs[def.key];
    if (value === undefined) continue;
    if (def.type === "number" && typeof value === "number") {
      const min = def.min ?? 0;
      const max = def.max ?? 100;
      if (def.visibility === "secret") {
        rows.push({ key: def.key, label: def.label, secret: true, band: bandOf(value, min, max) });
      } else {
        rows.push({
          key: def.key,
          label: def.label,
          unit: def.unit,
          secret: false,
          value,
          ratio: Math.max(0, Math.min(1, (value - min) / (max - min || 1))),
        });
      }
    } else {
      rows.push({ key: def.key, label: def.label, unit: def.unit, secret: def.visibility === "secret", text: String(value) });
    }
  }
  return rows;
}

export default function GalleryPanel({ state }: { state: WorldState | null }) {
  const [decls, setDecls] = useState<AttrDecl[]>([]);
  const [err, setErr] = useState("");

  // 注册表是"世界里有哪些属性"的唯一来源（I2）：拿不到就只显示身份/位置，不硬编码兜底
  useEffect(() => {
    let alive = true;
    getRegistry()
      .then((d) => {
        if (alive) setDecls(d);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

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

  const npcs = Object.values(state.entities)
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
        present,
        locName: loc ? state.entities[loc]?.name ?? loc : "",
        role: profile?.role ?? "身份不明",
        traits: profile?.traits ?? [],
        line: profile?.line ?? "",
        rows: rowsOf(e, decls),
      };
    });

  const metCount = npcs.filter((c) => c.met).length;
  const visited = Object.values(state.entities).filter((e) => e.kind === "loc").length;

  return (
    <div className="gallery-panel">
      <div className="gallery-head">
        <div>
          <strong>人物图鉴</strong>
          <span className="muted">
            {" "}
            · 已遇见 {metCount}/{npcs.length} · 校园地点 {visited}
          </span>
        </div>
        <span className="muted">遇到人（或和他同处一地）才会解锁；读数由玩法写入，随互动变化</span>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="gallery-grid">
        {npcs.map((c) => (
          <article key={c.id} className={`npc-card${c.met ? "" : " locked"}`}>
            <header>
              {/* 标题用「真名 · 外号」：校园里外号比真名先被记住，也顺手满足了"名字要好记" */}
              <h3>
                {c.met && (
                  <img
                    className="card-face"
                    src={`/portraits/${c.id}.jpg`}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                )}
                {c.met ? (c.traits[0] ? `${c.name} · ${c.traits[0]}` : c.name) : "？？？"}
              </h3>
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

                {c.rows.map((r) =>
                  r.secret ? (
                    <div className="stat" key={r.key}>
                      <span className="stat-label">{r.label}</span>
                      <span className={`chip guard ${r.band?.cls ?? ""}`}>{r.band?.label ?? r.text ?? "—"}</span>
                      <span className="stat-num muted">体感</span>
                    </div>
                  ) : r.text !== undefined ? (
                    <div className="row" key={r.key}>
                      <dt>{r.label}</dt>
                      <dd>{r.text}</dd>
                    </div>
                  ) : (
                    <div className="stat" key={r.key}>
                      <span className="stat-label">{r.label}</span>
                      <div className="bar">
                        <i style={{ width: `${(r.ratio ?? 0) * 100}%` }} />
                      </div>
                      <span className="stat-num">
                        {r.value}
                        {r.unit ?? ""}
                      </span>
                    </div>
                  ),
                )}

                <div className="row">
                  <dt>位置</dt>
                  <dd>{c.present ? "就在你身边" : c.locName || "行踪不明"}</dd>
                </div>
                {c.line && <p className="npc-line">「{c.line}」</p>}
              </>
            ) : (
              <p className="muted npc-line">在校园里遇到他，这一页才会写下名字。</p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
