/** 共享的 HTTP 小工具：统一错误码与响应拆包（见 docs/06 §4）。 */

export const jsonHeaders = { "content-type": "application/json" };

/** 游戏层拒绝：HTTP 200 + `{ok:false, code, message}`（见 docs/06 §4） */
export class GameError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}

type ApiFail = { ok: false; code: string; message: string };
export type Resp<T> = ({ ok: true } & T) | ApiFail;

export async function request<T>(label: string, path: string, init?: RequestInit): Promise<Resp<T>> {
  const r = await fetch(path, { credentials: "same-origin", ...init });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${label} ${r.status}${body ? `：${body.slice(0, 300)}` : ""}`);
  }
  return (await r.json()) as Resp<T>;
}

export function unwrap<T>(res: Resp<T>): T {
  if (!res.ok) throw new GameError(res.code, res.message);
  return res;
}

/** 管理端点统一走 `x-admin-token` */
export function adminHeaders(token: string): Record<string, string> {
  return { ...jsonHeaders, "x-admin-token": token };
}
