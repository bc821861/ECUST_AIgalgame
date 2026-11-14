/**
 * 指数退避重试。
 *
 * 只重试 shared 里 RETRYABLE 列出的码（超时 / 格式 / 限流），其余错误立刻上抛：
 * 契约错误（E_SCHEMA_INVALID 等）重试多少次都一样，只会放大账单。
 */
import { RETRYABLE, type ErrorCode } from "../../shared/src/index.ts";
import { isLlmError } from "./client.ts";

export interface RetryOptions {
  /** 额外重试次数（总尝试 = retries + 1），默认 2 */
  retries?: number;
  /** 首次退避毫秒，之后 ×2，默认 300 */
  baseMs?: number;
  /** 测试注入；默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryableError(err: unknown): err is Error & { code: ErrorCode } {
  return isLlmError(err) && RETRYABLE.includes(err.code);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < retries && isRetryableError(err);
      if (!canRetry) throw err;
      const delayMs = baseMs * 2 ** attempt;
      opts.onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
}
