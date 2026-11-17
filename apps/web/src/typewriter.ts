/**
 * 打字机：把整段文本/流式增量变成"逐字打出"的节奏。
 *
 * 设计要点：
 * - 同一时刻只有一行在打；固定文本（开场段落、facts、提示）走队列，流式叙事走 pending 缓冲；
 * - 标点停顿分级：小停顿（，、；：）160ms，大停顿（。！？…）320ms，行尾 90ms，读起来像呼吸；
 * - 模型可能一次性给一整段：缓冲超过阈值就加快步幅（2/4 字一拍），避免永远追不上；
 * - 与 React 解耦：只通过 onCommit / onTick 两个回调向上汇报，本类不 import React。
 */
import type { LineKind } from "./ui.ts";

export interface TypeItem {
  kind: LineKind;
  text: string;
}

export interface TypeLine {
  id: number;
  kind: LineKind;
  text: string;
}

const BASE_DELAY = 26;
const LINE_END_DELAY = 90;
const WAIT_DELAY = 55;
const MID_PAUSE = new Set(["，", "、", "；", "："]);
const BIG_PAUSE = new Set(["。", "！", "？", "…", "”", "」", "）"]);

export class Typewriter {
  private queue: TypeItem[] = [];
  private pending = "";
  private active: { kind: LineKind; text: string; fixed?: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ended = true;
  private readonly nextId: () => number;
  private readonly onCommit: (line: TypeLine) => void;
  private readonly onTick: () => void;

  constructor(nextId: () => number, onCommit: (line: TypeLine) => void, onTick: () => void) {
    this.nextId = nextId;
    this.onCommit = onCommit;
    this.onTick = onTick;
  }

  /** 清空一切（换房间/新开局时调用） */
  reset(): void {
    this.clearTimer();
    this.queue = [];
    this.pending = "";
    this.active = null;
    this.ended = true;
    this.onTick();
  }

  /** 固定文本行，按入队顺序逐个打出 */
  enqueue(items: TypeItem[]): void {
    for (const it of items) if (it.text.trim().length > 0) this.queue.push(it);
    this.kick();
  }

  /** 流式叙事增量：追加到当前叙事行的待打缓冲 */
  feed(text: string): void {
    this.pending += text;
    this.kick();
  }

  /** 回合结束时置 true：当前叙事行会在缓冲打完后收尾 */
  setTurnEnded(ended: boolean): void {
    this.ended = ended;
    if (ended) this.kick();
  }

  /** 立即完成所有正在打/排队的内容（玩家点日志或急着发下一句时用） */
  skip(): void {
    this.clearTimer();
    const a = this.active;
    if (a) {
      if (a.fixed !== undefined) {
        this.commit(a.kind, a.fixed);
      } else {
        const full = a.text + this.pending;
        this.pending = "";
        if (full.length > 0) this.commit(a.kind, full);
      }
      this.active = null;
    }
    for (const it of this.queue.splice(0)) this.commit(it.kind, it.text);
    this.onTick();
  }

  /** 停表（回到标题页等场景）；正在打的内容保留，等下次 kick 继续 */
  stop(): void {
    this.clearTimer();
  }

  get activeLine(): { kind: LineKind; text: string } | null {
    return this.active ? { kind: this.active.kind, text: this.active.text } : null;
  }

  get typing(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  private kick(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(this.step, 0);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private commit(kind: LineKind, text: string): void {
    this.onCommit({ id: this.nextId(), kind, text });
  }

  private readonly step = (): void => {
    this.timer = null;
    const cur = this.active;

    // 1) 当前行打完了吗？
    if (cur) {
      const fixedDone = cur.fixed !== undefined && cur.text.length >= cur.fixed.length;
      const streamDone = cur.fixed === undefined && this.pending.length === 0 && this.ended;
      if (fixedDone || streamDone) {
        if (cur.text.length > 0) this.commit(cur.kind, cur.text);
        this.active = null;
      }
    }

    // 2) 没有当前行：先从队列取固定文本，其次才起流式叙事行
    if (!this.active) {
      const next = this.queue.shift();
      if (next) {
        this.active = { kind: next.kind, text: "", fixed: next.text };
      } else if (this.pending.length > 0) {
        this.active = { kind: "narrative", text: "" };
      } else {
        this.onTick();
        return; // 空闲：停表
      }
    }

    // 3) 打出字符，并按"最后打出的那个字"决定下一拍节奏
    const a = this.active;
    let delay = BASE_DELAY;
    if (a.fixed !== undefined) {
      a.text = a.fixed.slice(0, a.text.length + 1);
      if (a.text.length >= a.fixed.length) delay = LINE_END_DELAY;
    } else {
      const n = this.pending.length > 320 ? 4 : this.pending.length > 140 ? 2 : 1;
      const chunk = this.pending.slice(0, n);
      this.pending = this.pending.slice(n);
      a.text += chunk;
      if (this.pending.length === 0) delay = this.ended ? LINE_END_DELAY : WAIT_DELAY;
    }
    const last = a.text[a.text.length - 1];
    if (last !== undefined) {
      if (MID_PAUSE.has(last)) delay = 160;
      if (BIG_PAUSE.has(last)) delay = 320;
    }
    this.onTick();
    this.timer = setTimeout(this.step, delay);
  };
}
