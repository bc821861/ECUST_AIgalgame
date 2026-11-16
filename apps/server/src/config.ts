/** 配置只从环境变量读；key 不进仓库、不进日志 */
import { randomBytes } from "node:crypto";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  contentDir: string;
  /** 地图草案审核/发布/生成的管理员令牌；未配置时生成本次进程的临时令牌 */
  adminToken: string;
  llm: { baseUrl: string; model: string; apiKey: string; timeoutMs: number };
}

function env(k: string, d: string): string {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : d;
}

export function loadConfig(): ServerConfig {
  const configuredAdminToken = env("GALGAME_ADMIN_TOKEN", "");
  const adminToken = configuredAdminToken || randomBytes(18).toString("base64url");
  if (!configuredAdminToken) {
    // 没有默认口令：每次启动随机生成，只打印到服务端控制台，避免同网段默认 token 可被滥用
    console.warn(`[config] GALGAME_ADMIN_TOKEN 未设置，本次启动使用临时管理员令牌：${adminToken}`);
  }
  return {
    port: Number(env("GALGAME_PORT", "8787")),
    host: env("GALGAME_HOST", "127.0.0.1"),
    dataDir: env("GALGAME_DATA_DIR", "data"),
    contentDir: env("GALGAME_CONTENT_DIR", "content"),
    adminToken,
    llm: {
      baseUrl: env("GALGAME_LLM_BASE_URL", ""),
      model: env("GALGAME_LLM_MODEL", "deepseek-v4.1-flash"),
      apiKey: env("GALGAME_LLM_API_KEY", ""),
      timeoutMs: Number(env("GALGAME_LLM_TIMEOUT_MS", "20000")),
    },
  };
}

export function hasLlm(cfg: ServerConfig): boolean {
  return cfg.llm.baseUrl !== "" && cfg.llm.apiKey !== "";
}
