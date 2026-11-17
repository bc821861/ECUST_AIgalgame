/**
 * 可替换的模型端口。
 *
 * 为什么不是"直接换个 llm 变量"：`Turn` / `MapService` / `DialogueHost` 在装配时拿到的是
 * 一个 LlmPort 引用，事后替换对象对它们无效。让它们共同持有同一个 `LlmSwitch`，
 * 设置改的是 switch 内部指向——三者立刻跟着换，不需要重启服务。
 *
 * 本文件不碰世界状态（I1），只是一个转发器。
 */
import type { LlmPort, LlmRequest, LlmResult } from "../../../packages/shared/src/contract/types.ts";

export class LlmSwitch implements LlmPort {
  private inner: LlmPort;

  constructor(initial: LlmPort) {
    this.inner = initial;
  }

  chat(req: LlmRequest): Promise<LlmResult> {
    return this.inner.chat(req);
  }

  /** 换模型实现；调用方负责保证新实现可用（本项目的设置会先探活一次） */
  use(next: LlmPort): void {
    this.inner = next;
  }

  current(): LlmPort {
    return this.inner;
  }
}
