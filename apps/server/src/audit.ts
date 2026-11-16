/**
 * 审核器的真实实现：用"另一个模型"审"被审模型的输出"。
 * 为什么放在 apps/server：引擎不该知道任何具体供应商；审核端口（AuditPort）在 engine 里定义。
 */
import type { LlmPort } from "../../../packages/shared/src/index.ts";
import type { AuditInput, AuditPort, AuditVerdict } from "../../../packages/engine/src/audit.ts";
import { buildAuditMessages, parseVerdict } from "../../../packages/engine/src/audit.ts";

export class LlmAudit implements AuditPort {
  constructor(private readonly llm: LlmPort) {}

  async review(input: AuditInput): Promise<AuditVerdict> {
    const res = await this.llm.chat({
      json: true,
      temperature: 0,
      maxTokens: 256,
      messages: buildAuditMessages(input),
      roomId: input.roomId,
      actorId: input.actorId,
    });
    const verdict = parseVerdict(res.json ?? res.raw);
    // 解析失败按"审核器故障"处理（Turn 会拦下文本但不惩罚玩家），不猜、不放行
    if (!verdict) throw new Error(`审核器输出无法解析：${res.raw.slice(0, 120)}`);
    return verdict;
  }
}
