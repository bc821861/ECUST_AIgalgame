/**
 * zod schema：Envelope —— 所有跨系统消息统一信封（03 §2.8 / §5）
 * 真源：contract/types.ts 的 Envelope<T>；这里给"无类型 payload"的通用版 + 绑 payload 的工厂。
 */
import { z } from "zod";
import { ActorIdSchema, IdSchema } from "./entity.ts";

export const EnvelopeSchema = z
  .object({
    v: z.literal(1).describe("信封版本，固定 1；破坏性变更走 CONTRACT_VERSION major"),
    id: IdSchema.describe("全局唯一事件 id（evt_*），客户端用它做幂等去重"),
    roomId: IdSchema.describe("所属房间（room_*）；seq 只在房间维度单调"),
    seq: z
      .number()
      .int()
      .min(1)
      .describe("房间内单调递增序号，从 1 开始；缺号由客户端判 E_SEQ_GAP 并申请快照"),
    ts: z.number().int().min(0).describe("服务器写入时间（毫秒时间戳），不参与排序"),
    actorId: ActorIdSchema.describe("触发者：plr_* / npc_* / sys"),
    type: z
      .string()
      .min(1)
      .max(64)
      .describe("消息类型：SSE turn.* / 领域事件 / net.hello 等，名字见 03 §4-§5"),
    payload: z.unknown().describe("类型相关负载；用 envelopeOf(具体 schema) 在边界解析"),
    causedBy: IdSchema.optional().describe("因果来源：引发这条事件的 Proposal/上一事件 id"),
    audience: z
      .array(ActorIdSchema)
      .max(16)
      .optional()
      .describe("可见范围（不填=公开）；过滤在 Transport 层完成，不在引擎里"),
  })
  .describe("Envelope：所有 HTTP/SSE/WS/内部队列消息的外壳");
export type EnvelopeParsed = z.infer<typeof EnvelopeSchema>;

/** 绑定具体 payload schema 的信封：envelopeOf(TurnPatchSchema) */
export const envelopeOf = <T extends z.ZodTypeAny>(payload: T) =>
  EnvelopeSchema.extend({ payload }).describe("带具体 payload 类型的 Envelope");

/** 手写类型版（z.infer 不便表达泛型，这里显式给出） */
export type EnvelopeOf<T> = Omit<EnvelopeParsed, "payload"> & { payload: T };
