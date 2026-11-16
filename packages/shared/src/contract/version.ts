/** 契约版本：与 docs/03-接口总表.md 顶部一致；scripts/check-contract.ts 会校验 */
export const CONTRACT_VERSION = "3.0.0" as const;
export const SCHEMA_VERSION = 2 as const;
export const API_VERSION = 2 as const;
/** 提示词版本：改 docs/prompts/* 必须 bump（KV 缓存前缀） */
export const PROMPT_VERSION = "2026-11-16.1" as const;
