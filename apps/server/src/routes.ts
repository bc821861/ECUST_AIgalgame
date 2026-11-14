/** HTTP/SSE 层：只做两件事——把请求变成 Turn.run 的调用、把 TurnEvent 原样写进 SSE。不含业务规则。 */
import type { FastifyInstance } from "fastify";
import type { Store, Turn, TurnEvent, WorldState } from "../../../packages/shared/src/contract/types.ts";

export interface AppDeps {
  store: Store;
  turn: Turn;
  createRoom(mode: "solo" | "coop"): Promise<{ roomId: string; actorId: string }>;
  version: string;
}

function sseWrite(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/v1/health", async () => ({ ok: true, contract: deps.version }));

  app.post("/api/v1/rooms", async (req) => {
    const body = (req.body ?? {}) as { mode?: "solo" | "coop" };
    return deps.createRoom(body.mode === "coop" ? "coop" : "solo");
  });

  app.get("/api/v1/rooms/:roomId/state", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    try {
      return await deps.store.snapshot(roomId);
    } catch {
      return reply.code(404).send({ error: "E_ROOM_NOT_FOUND" });
    }
  });

  app.get("/api/v1/rooms/:roomId/events", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const q = req.query as { fromSeq?: string; limit?: string };
    const from = Number(q.fromSeq ?? 0);
    const limit = Math.min(Number(q.limit ?? 200), 200);
    const events = await deps.store.events(roomId, from, limit);
    return { events, lastSeq: events.length ? events[events.length - 1]!.seq : from };
  });

  /** 一次行动 = 一条 SSE 流，事件名就是 TurnEvent.type */
  app.post("/api/v1/rooms/:roomId/turns", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const body = (req.body ?? {}) as { actorId?: string; input?: string; clientTurnId?: string; options?: Record<string, unknown> };
    if (!body.actorId || !body.input || !body.clientTurnId) {
      return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "actorId/input/clientTurnId 必填" });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    try {
      const it = deps.turn.run({ roomId, actorId: body.actorId, input: body.input, clientTurnId: body.clientTurnId, options: body.options as never });
      for await (const ev of it as AsyncIterable<TurnEvent>) {
        sseWrite(reply.raw, ev.type, ev);
        if (ev.type === "turn.commit" || ev.type === "turn.error") break;
      }
    } catch (e) {
      sseWrite(reply.raw, "turn.error", { type: "turn.error", code: "E_UPSTREAM", message: String(e), retryable: true });
    } finally {
      reply.raw.end();
    }
    return reply;
  });
}

export type { WorldState };
