import type { MapScene, MapView } from "./api.ts";
import { categoryLabel, sceneStatus, sceneStatusHint, sceneStatusLabel } from "./ui.ts";

interface Props {
  scene: MapScene;
  map: MapView;
  busy: boolean;
  onTravel: (scene: MapScene) => void;
  onDialogue: (dialogueId: string) => void;
  /** 链接里的场景：点链接内容或旁边的「前往此处」都跳到该场景（MapPanel 负责解析 id/名称） */
  onGoScene?: (idOrName: string) => void;
}

/** 场景详情：只渲染 MapView 里的服务端数据 */
export default function SceneDetail({ scene, map, busy, onTravel, onDialogue, onGoScene }: Props) {
  const here = scene.id === map.player.locId;
  const status = sceneStatus(scene);
  const built = status === "built";
  const statusHint = sceneStatusHint(scene);
  const category = categoryLabel(scene.category);
  const present = map.npcs.filter(
    (npc) => scene.presentNpcIds.includes(npc.id) || npc.locId === scene.id,
  );
  const resident = scene.residentNpcIds.map(
    (id) => map.npcs.find((npc) => npc.id === id)?.name ?? id,
  );

  return (
    <aside className="map-detail">
      <h2>
        {scene.name}
        <span className={`badge status ${status}`}>{sceneStatusLabel(scene)}</span>
        {here && <span className="badge you">你在这里</span>}
      </h2>
      <div className="muted">
        {category && <>{category} · </>}
        {scene.origin === "user" ? "玩家创造" : "校园场景"} · 坐标 ({scene.x}, {scene.y}) ·{" "}
        {scene.installed ? "已装入本局" : "未装入（前往时自动安装）"}
      </div>
      <p className="desc">{scene.desc}</p>
      <div className="chips">
        {scene.tags.map((tag) => (
          <span key={tag} className="chip tag">
            {tag}
          </span>
        ))}
      </div>
      {/* 「前往此处」放在「链接」上方：它是唯一的出发入口，点地图只选中不出发 */}
      <div className="travel-row">
        <button
          className="btn primary"
          onClick={() => onTravel(scene)}
          disabled={busy || !built || here}
          title={here ? "你已经在这里了" : !built ? statusHint : undefined}
        >
          前往此处
        </button>
        {!built && <span className={`scene-status-note ${status}`}>{statusHint}</span>}
        {built && here && <span className="muted">你已经在{scene.name}</span>}
      </div>

      <h3>链接</h3>
      <div className="links">
        {scene.links.length === 0 && <div className="muted">暂无链接。</div>}
        {scene.links.map((link) => {
          const key = `${link.kind}:${link.id}`;
          if (link.kind === "dialogue") {
            return (
              <button
                key={key}
                type="button"
                className="link-btn"
                onClick={() => onDialogue(link.id)}
                disabled={busy || !link.available || !here || !built}
                title={
                  !built ? statusHint : here ? undefined : "只能与当前所在地的场景对话"
                }
              >
                {link.label ?? "对话"}
                <span className="muted"> · 对话</span>
              </button>
            );
          }
          if (link.kind === "module") {
            return (
              <span key={key} className={`chip module${link.available ? "" : " off"}`}>
                {link.label ?? link.id}
              </span>
            );
          }
          if (link.kind === "npc") {
            const flag = scene.presentNpcIds.includes(link.id)
              ? "在场"
              : scene.residentNpcIds.includes(link.id)
                ? "常驻"
                : "不在";
            return (
              <span key={key} className="chip npc">
                {link.label ?? link.id}
                <span className="flag">{flag}</span>
              </span>
            );
          }
          if (link.kind === "scene") {
            const target =
              map.scenes.find((s) => s.id === link.id) ??
              map.scenes.find((s) => s.name === (link.label ?? ""));
            const targetBuilt = target ? sceneStatus(target) === "built" : false;
            const targetHere = target?.id === map.player.locId;
            const why = !target
              ? "地图上找不到该场景"
              : !targetBuilt
                ? sceneStatusHint(target)
                : targetHere
                  ? "你已经在这里了"
                  : undefined;
            return (
              <div key={key} className="link-scene-row">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onGoScene?.(target?.id ?? link.id)}
                  disabled={busy || !targetBuilt || targetHere || !onGoScene}
                  title={why}
                >
                  {link.label ?? target?.name ?? link.id}
                  <span className="muted"> · 场景</span>
                </button>
                <button
                  type="button"
                  className="btn ghost go-here"
                  onClick={() => onGoScene?.(target?.id ?? link.id)}
                  disabled={busy || !targetBuilt || targetHere || !onGoScene}
                  title={why}
                >
                  前往此处
                </button>
              </div>
            );
          }
          return (
            <span key={key} className="chip scene">
              {link.label ?? link.id}
            </span>
          );
        })}
      </div>

      <h3>在场</h3>
      <div className="muted">
        {present.length ? present.map((npc) => npc.name).join("、") : "只有你"}
        {here ? "（你也在）" : ""}
      </div>
      {resident.length > 0 && (
        <>
          <h3>常驻 NPC</h3>
          <div className="muted">{resident.join("、")}</div>
        </>
      )}
    </aside>
  );
}
