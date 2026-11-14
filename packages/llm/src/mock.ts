/**
 * MockLlm：给模块/引擎测试用的假 LLM。**不联网、不读 key、不花钱**。
 *
 * 两种用法：
 *   new MockLlm({ responses: ['{"mood":"calm"}', "第二段回复"] })
 *   new MockLlm({ handler: (req) => req.json ? '{"ok":true}' : "叙事文本" })
 *
 * json 请求同样走 safeParseJson：返回非法 JSON 会抛 E_LLM_FORMAT，
 * 方便测试 withRetry 的兜底路径（与真实网关行为一致）。
 */
import type { LlmPort, LlmRequest, LlmResult, Usage } from "../../shared/src/index.ts";
import { LlmError } from "./client.ts";
import { safeParseJson } from "./json.ts";

export interface MockLlmOptions {
  /** 按顺序返回的响应文本 */
  responses?: string[];
  /** 动态响应；与 responses 同时给出时 responses 优先耗尽后再用 handler */
  handler?: (req: LlmRequest) => string | Promise<string>;
  model?: string;
}

export class MockLlm implements LlmPort {
  private readonly responses: string[];
  private readonly handler: ((req: LlmRequest) => string | Promise<string>) | undefined;
  private readonly model: string;
  /** 每次调用的请求快照（按调用顺序） */
  readonly requests: LlmRequest[] = [];

  constructor(opts: MockLlmOptions = {}) {
    this.responses = [...(opts.responses ?? [])];
    this.handler = opts.handler;
    this.model = opts.model ?? "mock-model";
  }

  get calls(): number {
    return this.requests.length;
  }

  get lastRequest(): LlmRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async chat(req: LlmRequest): Promise<LlmResult> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });

    const raw = await this.nextText(req);
    const usage: Usage = {
      // 粗估：中文约 1.6 字/token，这里按 2 字符/token 取整，只用于断言「有没有记账」
      promptTokens: estimateTokens(req.messages.map((m) => m.content).join("")),
      completionTokens: estimateTokens(raw),
      calls: 1,
    };

    if (req.json === true) {
      const parsed = safeParseJson(raw);
      if (!parsed.ok) {
        throw new LlmError(parsed.code, `MockLlm 返回的不是合法 JSON：${parsed.message}`);
      }
      return { raw, json: parsed.value, usage, model: this.model, latencyMs: 0 };
    }
    return { raw, usage, model: this.model, latencyMs: 0 };
  }

  private async nextText(req: LlmRequest): Promise<string> {
    const queued = this.responses.shift();
    if (queued !== undefined) return queued;
    if (this.handler !== undefined) return this.handler(req);
    throw new LlmError("E_LLM_FORMAT", "MockLlm 的 responses 已用尽，且未提供 handler");
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}
