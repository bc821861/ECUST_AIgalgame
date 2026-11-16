/**
 * HTTP/SSE 层：只做两件事——把请求变成 service/turn 调用、把结果原样返回。
 * 不含业务规则；游戏层拒绝一律 HTTP 200 + {ok:false,code,message}，500 只表示未预期异常。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Store, Turn, TurnEvent } from "../../../packages/shared/src/contract/types.ts";
import { DialogueBodySchema, TickBodySchema, TravelBodySchema, zodMessage } from "./map.data.ts";
import type { MapService } from "./map.ts";

export interface AppDeps {
  store: Store;
  turn: Turn;
  map: MapService;
  createRoom(mode: "solo" | "coop"): Promise<{ roomId: string; actorId: string }>;
  version: string;
}

interface GameError {
  ok: false;
  code: string;
  message: string;
}

function sseWrite(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function schemaError(message: string): GameError {
  return { ok: false, code: "E_SCHEMA_INVALID", message };
}

/** 管理员令牌统一从 x-admin-token 头取；校验在 MapService/草案引擎里做 */
function adminTokenOf(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-admin-token"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

/** 未预期异常兜底成 500；业务拒绝不经过这里（它们在 service 里返回 ok:false） */
async function safe(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    // 内部异常（含绝对路径的 zod 错误等）只进服务端日志，不回给客户端
    console.error("[server] unhandled route error", e);
    return reply.code(500).send({ ok: false, code: "E_MODULE_FAULT", message: "服务器内部错误" });
  }
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

  app.get("/api/v1/rooms/:roomId/events", async (req) => {
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

  // ---------------------------------------------------------------- 地图（docs/06 §4）
  app.get("/api/v1/rooms/:roomId/map", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const q = req.query as { actorId?: string };
    return safe(reply, () => deps.map.getMap(roomId, q.actorId ?? "plr_self"));
  });

  app.post("/api/v1/rooms/:roomId/map/travel", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = TravelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () => deps.map.travel(roomId, parsed.data.actorId ?? "plr_self", parsed.data.locId));
  });

  app.post("/api/v1/rooms/:roomId/map/tick", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = TickBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () => deps.map.tick(roomId, parsed.data));
  });

  app.post("/api/v1/rooms/:roomId/map/dialogue", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = DialogueBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () =>
      deps.map.openDialogue(roomId, parsed.data.actorId ?? "plr_self", parsed.data.sceneId, parsed.data.dialogueId),
    );
  });

  app.post("/api/v1/map/drafts", (req, reply) => safe(reply, () => deps.map.createDraft(req.body)));

  app.get("/api/v1/map/drafts", (req, reply) => safe(reply, () => deps.map.listDrafts(adminTokenOf(req.headers))));

  app.get("/api/v1/map/drafts/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.getDraft(id));
  });

  app.post("/api/v1/admin/map/drafts/:id/review", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.reviewDraft(id, adminTokenOf(req.headers), req.body));
  });

  app.post("/api/v1/admin/map/drafts/:id/publish", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.publishDraft(id, adminTokenOf(req.headers), req.body));
  });

  app.post("/api/v1/admin/map/drafts/:id/generate", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.retryGenerate(id, adminTokenOf(req.headers)));
  });
}
