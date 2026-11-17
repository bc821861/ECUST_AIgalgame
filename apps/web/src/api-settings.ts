/** 模型接入（玩家自备 key）：GET/POST/DELETE /api/v1/settings/llm（docs/03 §5.2.2）。 */
import { jsonHeaders, request, unwrap } from "./http.ts";

export interface LlmSettingsView {
  mode: "offline" | "remote";
  baseUrl: string;
  model: string;
  /** 配置已保存到服务端本地（重启后仍生效） */
  persisted: boolean;
}

export async function getLlmSettings(): Promise<LlmSettingsView> {
  const res = await request<{ view: LlmSettingsView }>("llm settings", "/api/v1/settings/llm");
  return unwrap(res).view;
}

export interface ConnectBody {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export async function connectLlm(body: ConnectBody): Promise<LlmSettingsView> {
  const res = await request<{ view: LlmSettingsView }>("connect llm", "/api/v1/settings/llm", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  return unwrap(res).view;
}

/** 断开并清除服务端保存的配置，退回离线叙述 */
export async function disconnectLlm(): Promise<LlmSettingsView> {
  const res = await request<{ view: LlmSettingsView }>("disconnect llm", "/api/v1/settings/llm", {
    method: "DELETE",
  });
  return unwrap(res).view;
}
