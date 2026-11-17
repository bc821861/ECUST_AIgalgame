/**
 * 简易用户系统：邀请注册、用户名密码登录、HttpOnly Cookie 会话。
 *
 * 身份只从会话来（`ecust_sid`），不再相信 localStorage / X-User-Id / body.userId。
 * 部署时用 GALGAME_AUTH_REQUIRED=1 打开强制登录；本地测试默认关闭，保留旧 header 兼容。
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { normalizeUsername, validatePassword, type UserStore } from "./users.ts";
import { clearSessionCookie, sessionCookie, SessionStore } from "./sessions.ts";

export interface AuthUser {
  userId: string;
  username: string;
}

export interface AuthOptions {
  users: UserStore;
  sessions: SessionStore;
  /** 注册邀请码；空 = 关闭注册（部署时必填） */
  inviteCode: string;
  /** true 时所有 /api（除公开端点）都要求会话 */
  required: boolean;
  /** HTTPS 部署时 Cookie 加 Secure */
  secureCookies: boolean;
  ttlDays: number;
}

export type AuthResult =
  | { ok: true; user: AuthUser; token: string }
  | { ok: false; status: number; code: string; message: string };

const RegisterBody = z.object({
  username: z.string(),
  password: z.string(),
  inviteCode: z.string().optional(),
});
const LoginBody = z.object({
  username: z.string(),
  password: z.string(),
});

const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 60_000;

function publicUser(user: { userId: string; username: string }): AuthUser {
  return { userId: user.userId, username: user.username };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AuthService {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly opts: AuthOptions) {}

  get required(): boolean {
    return this.opts.required;
  }

  resolve(req: FastifyRequest): AuthUser | null {
    return this.opts.sessions.userFromHeader(req.headers.cookie);
  }

  resolveUserId(req: FastifyRequest): string | undefined {
    return this.resolve(req)?.userId;
  }

  me(req: FastifyRequest): AuthUser | null {
    return this.resolve(req);
  }

  async register(raw: unknown): Promise<AuthResult> {
    const parsed = RegisterBody.safeParse(raw ?? {});
    if (!parsed.success) return fail(400, "E_SCHEMA_INVALID", "用户名和密码必填");
    if (!this.opts.inviteCode) return fail(403, "E_FORBIDDEN", "注册未开放（服务端未配置邀请码）");
    if (!safeEqual(parsed.data.inviteCode ?? "", this.opts.inviteCode)) {
      return fail(403, "E_FORBIDDEN", "邀请码不正确");
    }
    const username = normalizeUsername(parsed.data.username);
    if (!username) return fail(400, "E_SCHEMA_INVALID", "用户名需 3–24 位小写字母/数字/下划线/连字符");
    const password = validatePassword(parsed.data.password);
    if (!password) return fail(400, "E_SCHEMA_INVALID", "密码需 8–128 位");

    const created = await this.opts.users.create(username, password);
    if (!created.ok) return fail(409, created.code, created.message);
    const user = publicUser(created.user);
    return { ok: true, user, token: this.opts.sessions.create(user) };
  }

  async login(raw: unknown, ip: string): Promise<AuthResult> {
    const parsed = LoginBody.safeParse(raw ?? {});
    if (!parsed.success) return fail(401, "E_UNAUTHORIZED", "用户名或密码错误");
    const username = normalizeUsername(parsed.data.username) ?? parsed.data.username.trim().toLowerCase();
    const key = `${ip}:${username}`;
    if (!this.allowAttempt(key)) return fail(429, "E_RATE_LIMITED", "尝试过于频繁，请稍后再试");

    const account = await this.opts.users.verify(username, parsed.data.password);
    if (!account) return fail(401, "E_UNAUTHORIZED", "用户名或密码错误");
    this.failures.delete(key);
    const user = publicUser(account);
    return { ok: true, user, token: this.opts.sessions.create(user) };
  }

  logout(req: FastifyRequest): void {
    this.opts.sessions.destroy(this.opts.sessions.cookieToken(req.headers.cookie));
  }

  cookieFor(token: string): string {
    return sessionCookie(token, this.opts.ttlDays * 24 * 60 * 60, this.opts.secureCookies);
  }

  clearCookie(): string {
    return clearSessionCookie(this.opts.secureCookies);
  }

  private allowAttempt(key: string): boolean {
    const now = Date.now();
    const current = this.failures.get(key);
    if (!current || current.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return true;
    }
    if (current.count >= MAX_LOGIN_FAILURES) return false;
    current.count += 1;
    return true;
  }
}

function fail(status: number, code: string, message: string): AuthResult {
  return { ok: false, status, code, message };
}

function sendFail(reply: FastifyReply, result: Extract<AuthResult, { ok: false }>): FastifyReply {
  return reply.code(result.status).send({ ok: false, code: result.code, message: result.message });
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post("/api/v1/auth/register", async (req, reply) => {
    const result = await auth.register(req.body);
    if (!result.ok) return sendFail(reply, result);
    reply.header("set-cookie", auth.cookieFor(result.token));
    return { ok: true, user: result.user };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const result = await auth.login(req.body, req.ip ?? "?");
    if (!result.ok) return sendFail(reply, result);
    reply.header("set-cookie", auth.cookieFor(result.token));
    return { ok: true, user: result.user };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    auth.logout(req);
    reply.header("set-cookie", auth.clearCookie());
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (req, reply) => {
    const user = auth.me(req);
    if (!user) return reply.code(401).send({ ok: false, code: "E_UNAUTHORIZED", message: "未登录" });
    return { ok: true, user };
  });
}
