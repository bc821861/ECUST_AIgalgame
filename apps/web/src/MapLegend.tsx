/** 地图图例：状态色块与「当前所在」提示，纯展示、不吃指针事件。 */
export default function MapLegend() {
  return (
    <div className="map-legend">
      <span className="map-legend-item">
        <i className="map-dot built" />
        已建成
      </span>
      <span className="map-legend-item">
        <i className="map-dot under_construction" />
        在建
      </span>
      <span className="map-legend-item">
        <i className="map-dot planned" />
        规划中
      </span>
      <span className="map-legend-item">
        <i className="map-dot current" />
        当前所在
      </span>
    </div>
  );
}
