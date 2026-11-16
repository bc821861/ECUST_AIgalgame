/**
 * 模型这一步：问一次 → 解析 → 过滤（现实锚定）→ 必要时带拒绝原因再问一次。
 * 从 Turn 里拆出来，是为了让"怎么问模型"和"模型说完之后引擎怎么裁决"互不干扰。
 */
import type { ActorId, LlmPort, Proposal, TurnRequest, Usage, WorldState } from "../../shared/src/index.ts";
import type { RealityKind, RealityPolicy } from "./reality.ts";
import { filterProposals, realityFraming } from "./reality.ts";
import { errMessage, parseTurn } from "./turn.parse.ts";
import { buildTurnPrompt } from "./turn.prompt.ts";

export interface TurnLlmDeps {
  llm: LlmPort;
  reality: RealityPolicy;
  buildPrompt?: (state: WorldState, actorId: ActorId, input: string) => string;
}

export interface LlmProduct {
  proposals: Proposal[];
  text: string;
  usage?: Usage;
  /** 因"偏离现实"被丢掉的提案数：要如实告诉玩家 */
  dropped: number;
}

export interface RejectedReason {
  code: string;
  detail: string;
}

export class TurnLlm {
  constructor(private readonly deps: TurnLlmDeps) {}

  /** 一次模型调用；输出不是 JSON 就抛 E_LLM_FORMAT（上层按可重试错误上报） */
  async ask(req: TurnRequest, state: WorldState, kind: RealityKind | null): Promise<LlmProduct> {
    const res = await this.deps.llm.chat({
      json: true,
      messages: [
        { role: "system", content: this.prompt(state, req.actorId, req.input, kind) },
        { role: "user", content: req.input },
      ],
      maxTokens: 900,
    });
    const parsed = parseTurn(res.raw);
    if (!parsed) throw Object.assign(new Error("模型输出不是合法 JSON"), { code: "E_LLM_FORMAT" });
    return this.product(parsed.proposals ?? [], parsed.narrative, parsed.dialogue, res.usage, req, kind);
  }

  /** 带失败原因的第二次询问（最多一次）；仍然坏就返回 {ok:false} 交给上层报错 */
  async repair(
    req: TurnRequest,
    state: WorldState,
    rejected: readonly RejectedReason[],
    kind: RealityKind | null,
  ): Promise<({ ok: true } & LlmProduct) | { ok: false; error: string }> {
    try {
      const res = await this.deps.llm.chat({
        json: true,
        messages: [
          { role: "system", content: this.prompt(state, req.actorId, req.input, kind) },
          { role: "user", content: req.input },
          {
            role: "user",
            content: [
              "上一批 proposals 被引擎拒绝了，原因如下：",
              ...rejected.map((r) => `- ${r.code}: ${r.detail}`),
              "请只输出 JSON，修正 proposals（不要重复已成功的操作），仍用 narrative/dialogue/proposals 三个字段。",
            ].join("\n"),
          },
        ],
        maxTokens: 900,
      });
      const parsed = parseTurn(res.raw);
      if (!parsed) return { ok: false, error: "模型修复输出不是合法 JSON" };
      return { ok: true, ...this.product(parsed.proposals ?? [], parsed.narrative, parsed.dialogue, res.usage, req, kind) };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
    }
  }

  private product(
    proposals: readonly Proposal[],
    narrative: string | undefined,
    dialogue: string | undefined,
    usage: Usage | undefined,
    req: TurnRequest,
    kind: RealityKind | null,
  ): LlmProduct {
    // 诱导性发言换不来数值：过滤必须在代码里做，不能只靠提示词
    const filtered = filterProposals(this.deps.reality, kind, proposals, req.actorId);
    return {
      proposals: filtered.kept,
      text: [narrative, dialogue].filter(Boolean).join("\n"),
      ...(usage ? { usage } : {}),
      dropped: filtered.dropped.length,
    };
  }

  private prompt(state: WorldState, actorId: ActorId, input: string, kind: RealityKind | null): string {
    if (this.deps.buildPrompt) return this.deps.buildPrompt(state, actorId, input);
    return buildTurnPrompt(state, actorId, input, { framing: realityFraming(this.deps.reality, kind) });
  }
}
