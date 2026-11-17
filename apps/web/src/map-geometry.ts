/** 地图视口的纯几何计算：缩放/平移不变量集中在这里，组件只负责交互与渲染。 */

export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 拖拽超过这个屏幕像素才认定为「平移」，否则保留点击语义 */
export const DRAG_THRESHOLD_PX = 4;
/** 缩放上限相对 fit 的倍数（下限就是 fit：整张图刚好可见） */
export const MAX_ZOOM_MULTIPLIER = 4;

export function fitScaleOf(w: number, h: number, vp: Size): number {
  return Math.min(vp.w / w, vp.h / h);
}

/** 初始视图：整张底图等比缩放后居中 */
export function fitView(w: number, h: number, vp: Size): ViewTransform {
  const scale = fitScaleOf(w, h, vp);
  return { scale, x: (vp.w - w * scale) / 2, y: (vp.h - h * scale) / 2 };
}

/**
 * 夹紧缩放（fit ~ fit*4）并约束平移：比视口小的方向自动居中，
 * 大的方向不许拖出空白，保证任何缩放级别下画面都不「丢」。
 */
export function clampView(view: ViewTransform, w: number, h: number, vp: Size): ViewTransform {
  const fit = fitScaleOf(w, h, vp);
  const scale = Math.min(Math.max(view.scale, fit), fit * MAX_ZOOM_MULTIPLIER);
  const scaledW = w * scale;
  const scaledH = h * scale;
  const axis = (pos: number, scaled: number, viewport: number): number =>
    scaled <= viewport ? (viewport - scaled) / 2 : Math.min(0, Math.max(viewport - scaled, pos));
  return { scale, x: axis(view.x, scaledW, vp.w), y: axis(view.y, scaledH, vp.h) };
}

/** 以 (px,py)（视口内坐标）为不动点缩放，返回新的 transform */
export function zoomAt(
  view: ViewTransform,
  factor: number,
  px: number,
  py: number,
  w: number,
  h: number,
  vp: Size,
): ViewTransform {
  const fit = fitScaleOf(w, h, vp);
  const scale = Math.min(Math.max(view.scale * factor, fit), fit * MAX_ZOOM_MULTIPLIER);
  const wx = (px - view.x) / view.scale;
  const wy = (py - view.y) / view.scale;
  return clampView({ scale, x: px - wx * scale, y: py - wy * scale }, w, h, vp);
}

/** 统一不同 deltaMode 的滚轮增量（行/页 → 像素），否则 Firefox 缩放会过冲 */
export function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 400;
  return e.deltaY;
}
