/**
 * 简易用户库：`data/auth/users.json`（账号 + scrypt 密码哈希）。
 *
 * 只解决“你是谁”，不负责房间权限。用户名是稳定的登录名，userId 是服务端签发的
 * 不可变 id（存档/记忆/历史都 key 在它上面）；改名不换 id。
 *
 * 不引入依赖：密码哈希用 Node 自带 scrypt，校验用 timingSafeEqual。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export interface Account {
  userId: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  disabled?: boolean;
}

interface UsersFile {
  version: 1;
  users: Account[];
}

export type CreateResult =
  | { ok: true; user: Account }
  | { ok: false; code: "E_ID_TAKEN"; message: string };

/** 统一小写；用户名只允许 [a-z0-9_-]，避免大小写导致两个“同名”账号 */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return USERNAME_RE.test(username) ? username : null;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 8 || value.length > 128) return null;
  return value;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })) as Buffer;
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(saltHex ?? "", "hex");
  const expected = Buffer.from(hashHex ?? "", "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = (await scrypt(password, salt, expected.length, { N, r, p })) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function isAccount(value: unknown): value is Account {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.userId === "string" &&
    typeof a.username === "string" &&
    typeof a.passwordHash === "string" &&
    typeof a.createdAt === "number"
  );
}

export class UserStore {
  private users: Account[] = [];
  /** 注册/写入串行：同一进程内不并发重写 users.json */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<UsersFile>;
      this.users = Array.isArray(raw.users) ? raw.users.filter(isAccount) : [];
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.users = [];
      if (code !== "ENOENT") console.warn("[auth] users.json 读取失败，按空库启动：", (e as Error).message);
    }
  }

  find(username: string): Account | undefined {
    return this.users.find((u) => u.username === username);
  }

  get(userId: string): Account | undefined {
    return this.users.find((u) => u.userId === userId);
  }

  create(username: string, password: string): Promise<CreateResult> {
    return this.serial(async () => {
      if (this.find(username)) return { ok: false, code: "E_ID_TAKEN", message: "用户名已被占用" };
      const user: Account = {
        userId: `usr_${randomBytes(8).toString("hex")}`,
        username,
        passwordHash: await hashPassword(password),
        createdAt: Date.now(),
      };
      this.users.push(user);
      try {
        await this.write();
      } catch (e) {
        // 写盘失败必须回滚内存：否则本次失败会在进程里留下“幽灵账号”，
        // 重试注册会误报 E_ID_TAKEN，重启后账号又消失。
        this.users = this.users.filter((u) => u.userId !== user.userId);
        throw e;
      }
      return { ok: true, user };
    });
  }

  async verify(username: string, password: string): Promise<Account | null> {
    const user = this.find(username);
    if (!user || user.disabled) return null;
    return (await verifyPassword(password, user.passwordHash)) ? user : null;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async write(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const body: UsersFile = { version: 1, users: this.users };
    await writeFile(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
