/**
 * Transport：内存版发布/订阅。按 actorId 过滤，且过滤发生在投递之前（docs/04 §6）。
 * 引擎不认识 HTTP/SSE；这里只是把 Envelope 发给关心它的人。
 */
import type { ActorId, Envelope, RoomId, Transport } from "../../shared/src/index.ts";

interface Sub {
  actorId: ActorId;
  fromSeq: number;
  sink: (e: Envelope) => void;
}

export class MemoryTransport implements Transport {
  private readonly subs = new Map<RoomId, Set<Sub>>();
  private readonly history = new Map<RoomId, Envelope[]>();
  private readonly online = new Map<RoomId, Set<ActorId>>();

  subscribe(roomId: RoomId, actorId: ActorId, fromSeq: number, sink: (e: Envelope) => void): () => void {
    const sub: Sub = { actorId, fromSeq, sink };
    const set = this.subs.get(roomId) ?? new Set<Sub>();
    this.subs.set(roomId, set);
    set.add(sub);
    this.online.get(roomId) ?? this.online.set(roomId, new Set()).get(roomId)!.add(actorId);
    // 补发断线期间的历史（Last-Event-ID 语义）
    for (const env of this.history.get(roomId) ?? []) {
      if (env.seq > fromSeq) this.deliver(sub, env);
    }
    return () => {
      set.delete(sub);
    };
  }

  publish(env: Envelope): void {
    const log = this.history.get(env.roomId) ?? [];
    log.push(env);
    this.history.set(env.roomId, log);
    for (const sub of this.subs.get(env.roomId) ?? []) this.deliver(sub, env);
  }

  presence(roomId: RoomId): ActorId[] {
    return [...(this.online.get(roomId) ?? [])];
  }

  /** 测试/调试用：某房间已投递的事件 */
  history_(roomId: RoomId): Envelope[] {
    return [...(this.history.get(roomId) ?? [])];
  }

  private deliver(sub: Sub, env: Envelope): void {
    if (env.seq <= sub.fromSeq) return;
    // audience 存在 = 只投给名单内；private 记忆/密谋靠它，不靠前端自觉
    if (env.audience && env.audience.length > 0 && !env.audience.includes(sub.actorId)) return;
    sub.sink(env);
  }
}
