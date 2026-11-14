/**
 * Store：事件日志 + 投影缓存。世界状态不是被"改"出来的，而是把日志折出来的。
 * 因此 snapshot/replay 是同一个函数的两条路径 —— 这是 determinism 的来源。
 *
 * `EventLog` 比契约里的 `Store` 多三个同步方法，只给 Arbiter 用（它是唯一写入口）。
 * 外部（Turn / HTTP / modules）只应该拿到 `Store`，不该能看到 append。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Envelope, RoomId, Store, WorldState } from "../../shared/src/contract/types.ts";
import { applyEvent, createInitialState } from "./projection.ts";

export interface StoreOptions {
  worldId?: string;
  locId?: string;
}

export interface EventLog extends Store {
  /** 当前最新 seq（0 = 空房间） */
  seq(roomId: RoomId): number;
  /** 同步视图；返回的对象是内部状态，调用方不得修改（要改就用 snapshot） */
  state(roomId: RoomId): WorldState;
  /** 追加事件并逐条投影。seq 必须连续，不连续说明有第二个写入口（bug） */
  append(roomId: RoomId, envs: Envelope[]): void;
}

export class EventSourcedStore implements EventLog {
  protected readonly logs = new Map<RoomId, Envelope[]>();
  protected readonly states = new Map<RoomId, WorldState>();
  protected readonly opts: StoreOptions;

  constructor(opts: StoreOptions = {}) {
    this.opts = opts;
  }

  protected initial(roomId: RoomId): WorldState {
    return createInitialState(roomId, { worldId: this.opts.worldId, locId: this.opts.locId });
  }

  state(roomId: RoomId): WorldState {
    let s = this.states.get(roomId);
    if (!s) {
      s = this.initial(roomId);
      this.states.set(roomId, s);
    }
    return s;
  }

  seq(roomId: RoomId): number {
    const log = this.logs.get(roomId);
    return log && log.length ? (log[log.length - 1]?.seq ?? 0) : 0;
  }

  append(roomId: RoomId, envs: Envelope[]): void {
    if (envs.length === 0) return;
    const log = this.logs.get(roomId) ?? [];
    this.logs.set(roomId, log);
    let state = this.state(roomId);
    for (const env of envs) {
      const expected = (log[log.length - 1]?.seq ?? 0) + 1;
      if (env.seq !== expected) {
        throw new Error(`E_SEQ_GAP: room=${roomId} expected seq ${expected}, got ${env.seq}`);
      }
      log.push(env);
      state = applyEvent(state, env);
    }
    this.states.set(roomId, state);
  }

  async snapshot(roomId: RoomId): Promise<WorldState> {
    return structuredClone(this.state(roomId));
  }

  async events(roomId: RoomId, fromSeq: number, limit = 200): Promise<Envelope[]> {
    const log = this.logs.get(roomId) ?? [];
    return log.filter((e) => e.seq >= fromSeq).slice(0, limit);
  }

  async replay(roomId: RoomId, toSeq?: number): Promise<WorldState> {
    const log = this.logs.get(roomId) ?? [];
    let state = this.initial(roomId);
    for (const env of log) {
      if (toSeq !== undefined && env.seq > toSeq) break;
      state = applyEvent(state, env);
    }
    return state;
  }
}

/**
 * 文件版：每房间一个 JSONL，一行一个 Envelope。
 * 选 jsonl 而不是 sqlite：崩溃时最多丢最后一行（它是坏行，可跳过），
 * 而且 `tail -1` 就能看最新状态，M0 阶段排查成本最低。
 */
export class FileStore extends EventSourcedStore {
  private readonly loaded = new Set<RoomId>();
  private readonly pending = new Map<RoomId, Promise<void>>();
  private readonly dir: string;

  constructor(dir = path.join(process.cwd(), "data", "rooms"), opts: StoreOptions = {}) {
    super(opts);
    this.dir = dir;
  }

  private file(roomId: RoomId): string {
    return path.join(this.dir, `${roomId}.jsonl`);
  }

  /** 懒加载：先把文件回放成内存日志，之后所有读都走内存 */
  private async ensure(roomId: RoomId): Promise<void> {
    if (this.loaded.has(roomId)) return;
    this.loaded.add(roomId);
    const file = this.file(roomId);
    if (!existsSync(file)) return;
    const text = await readFile(file, "utf8");
    const envs: Envelope[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        envs.push(JSON.parse(line) as Envelope);
      } catch {
        // 崩溃留下的半行：跳过而不是让整份存档读不出来
      }
    }
    super.append(roomId, envs);
  }

  override async snapshot(roomId: RoomId): Promise<WorldState> {
    await this.ensure(roomId);
    return super.snapshot(roomId);
  }

  override async events(roomId: RoomId, fromSeq: number, limit?: number): Promise<Envelope[]> {
    await this.ensure(roomId);
    return super.events(roomId, fromSeq, limit);
  }

  override async replay(roomId: RoomId, toSeq?: number): Promise<WorldState> {
    await this.ensure(roomId);
    return super.replay(roomId, toSeq);
  }

  override append(roomId: RoomId, envs: Envelope[]): void {
    // 自己写过的房间不需要再从文件回放（否则会把同一批事件读第二遍，seq 撞车）
    this.loaded.add(roomId);
    super.append(roomId, envs);
    const prev = this.pending.get(roomId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.file(roomId), envs.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      })
      .catch(() => {
        // 落盘失败不抛给调用方：内存状态已经对，重启时最多丢这批事件并回退到旧存档
      });
    this.pending.set(roomId, next);
  }

  /** 测试与小规模脚本用：等待所有写盘完成 */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.values()]);
  }
}
