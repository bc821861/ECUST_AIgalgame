/**
 * 会话：随机 token 放 HttpOnly Cookie，服务端只存 token 的 sha256。
 *
 * MVP 用内存表：进程重启后所有人重新登录。单实例部署；不引入 Redis/依赖。
 */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "ecust_sid";

export interface SessionUser {
  userId: string;
  username: string;
}

interface StoredSession extends SessionUser {
  expiresAt: number;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SessionStore {
  private readonly map = new Map<string, StoredSession>();

  constructor(private readonly ttlMs: number = 7 * 24 * 60 * 60 * 1000) {}

  create(user: SessionUser): string {
    const token = randomBytes(32).toString("base64url");
    this.map.set(tokenHash(token), { ...user, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  get(token: string | null | undefined): SessionUser | null {
    if (!token) return null;
    const key = tokenHash(token);
    const session = this.map.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return { userId: session.userId, username: session.username };
  }

  destroy(token: string | null | undefined): void {
    if (token) this.map.delete(tokenHash(token));
  }

  /** 从 Cookie 头取 ecust_sid（只依赖 header 字符串，不引入 cookie 依赖） */
  cookieToken(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE) return rest.join("=") || null;
    }
    return null;
  }

  userFromHeader(cookieHeader: string | undefined): SessionUser | null {
    return this.get(this.cookieToken(cookieHeader));
  }
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
