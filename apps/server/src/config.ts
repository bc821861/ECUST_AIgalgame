/** 配置只从环境变量读；key 不进仓库、不进日志 */
export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  contentDir: string;
  /** 地图草案审核/发布/生成的管理员令牌；缺省只适合本地开发 */
  adminToken: string;
  llm: { baseUrl: string; model: string; apiKey: string; timeoutMs: number };
}

function env(k: string, d: string): string {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : d;
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(env("GALGAME_PORT", "8787")),
    host: env("GALGAME_HOST", "127.0.0.1"),
    dataDir: env("GALGAME_DATA_DIR", "data"),
    contentDir: env("GALGAME_CONTENT_DIR", "content"),
    adminToken: env("GALGAME_ADMIN_TOKEN", "dev-admin"),
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
