/** 简易用户系统的 HTTP 层：登录态只在 HttpOnly Cookie 里，前端不存 token/userId。 */
import { GameError, jsonHeaders } from "./http.ts";

export interface AuthUser {
  userId: string;
  username: string;
}

async function parseError(res: Response): Promise<GameError> {
  try {
    const body = (await res.json()) as { code?: string; message?: string };
    return new GameError(body.code ?? "E_UNAUTHORIZED", body.message ?? "请求失败");
  } catch {
    return new GameError("E_UNAUTHORIZED", `请求失败（HTTP ${res.status}）`);
  }
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/v1/auth/me", { credentials: "same-origin" });
  if (res.status === 401) return null;
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseError(res);
  return ((await res.json()) as { user: AuthUser }).user;
}

export async function register(username: string, password: string, inviteCode: string): Promise<AuthUser> {
  const res = await fetch("/api/v1/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: JSON.stringify({ username, password, inviteCode }),
  });
  if (!res.ok) throw await parseError(res);
  return ((await res.json()) as { user: AuthUser }).user;
}

export async function logout(): Promise<void> {
  await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}
