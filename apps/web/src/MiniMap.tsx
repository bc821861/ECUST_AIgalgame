/**
 * 左上角的小地图：一眼看到"我在校园的哪个点"，点一下展开成全屏地图。
 *
 * 它只读 `/map` 的同一份数据（底图 + 场景坐标），不自己推演任何东西。
 * 底图是 6000×4500 的大图，这里用 background-size 压成缩略，
 * 当前所在位置按坐标换算成百分比叠上去——所以挪动到别的场景时，亮点会跟着走。
 */
import { useEffect, useState } from "react";
import { getMap } from "./api.ts";
import type { MapView } from "./api.ts";

export interface MiniMapProps {
  roomId: string;
  onOpen: () => void;
}

export default function MiniMap({ roomId, onOpen }: MiniMapProps) {
  const [map, setMap] = useState<MapView | null>(null);

  useEffect(() => {
    let alive = true;
    if (!roomId) return;
    getMap(roomId)
      .then((m) => {
        if (alive) setMap(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [roomId]);

  const here = map?.scenes.find((s) => s.id === map.player.locId);
  const pct = (v: number, total: number): string => `${(v / (total || 1)) * 100}%`;

  return (
    <button
      type="button"
      className="mini-map"
      onClick={onOpen}
      title="展开校园地图，挑选要去的地方"
      aria-label="展开校园地图"
    >
      {map?.image ? (
        <span className="mini-map-img" style={{ backgroundImage: `url(${map.image})` }} />
      ) : (
        <span className="mini-map-img" />
      )}
      <span className="mini-map-veil" />
      {here && map && (
        <span
          className="mini-map-here"
          style={{ left: pct(here.x, map.width), top: pct(here.y, map.height) }}
        >
          <i />
        </span>
      )}
      <span className="mini-map-hint">地图</span>
    </button>
  );
}
