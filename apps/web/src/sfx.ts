/**
 * 极轻的按键音效：Web Audio 合成，零依赖、零音频文件。
 * 浏览器要求"用户手势之后才能出声"，所以 AudioContext 在第一次点击时才创建。
 */
const KEY = "ecust.galgame.sound";

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // 隐私模式写不了，忽略
  }
}

/** 短促"嗒"音；kind 决定音高走向（tap 下行 / open 上行 / confirm 双音感） */
export function blip(kind: "tap" | "open" | "confirm" = "tap"): void {
  const c = ensureCtx();
  if (!c || !soundOn()) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "triangle";
  const [f0, f1] = kind === "confirm" ? [660, 880] : kind === "open" ? [440, 660] : [560, 420];
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + 0.08);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.05, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}

/** 全局按钮音效：capture 阶段挂一次，覆盖所有页面（含后续新增的按钮） */
export function installClickSound(): () => void {
  const onDown = (e: PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && el.closest("button")) blip("tap");
  };
  document.addEventListener("pointerdown", onDown, true);
  return () => document.removeEventListener("pointerdown", onDown, true);
}
