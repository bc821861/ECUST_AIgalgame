/**
 * 单一 auth 域存储（收敛稿 B1 / PR #19 P1-3）：损坏 fail-fast 保留文件、旧 users.json 迁移、
 * 注册与邀请扣减原子性。断言状态/错误类型/文件内容，不断言文案。
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempDir } from "@galgame/testkit";
import { AuthStore, AuthStoreCorruptError } from "./auth-store.ts";

function storeAt(dir: string): AuthStore {
  return new AuthStore(path.join(dir, "auth.json"));
}

describe("损坏 fail-fast（P1-3）", () => {
  it("非法 JSON：抛 AuthStoreCorruptError，且故障文件原样保留（不按空库覆盖）", async () => {
    const dir = tempDir("galgame-authstore-corrupt-");
    const file = path.join(dir, "auth.json");
    await writeFile(file, "{broken json", "utf8");
    const store = storeAt(dir);
    await expect(store.load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    expect(await readFile(file, "utf8")).toBe("{broken json");
  });

  it("合法 JSON 但 schema 不符：同样 fail-fast 保留文件", async () => {
    const dir = tempDir("galgame-authstore-schema-");
    const file = path.join(dir, "auth.json");
    const bad = JSON.stringify({ version: 2, users: [{ userId: "u1" }], invites: [], resets: [], settings: {} });
    await writeFile(file, bad, "utf8");
    await expect(storeAt(dir).load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    expect(await readFile(file, "utf8")).toBe(bad);
  });

  it("文件不存在（ENOENT）：按空库启动，可正常注册", async () => {
    const store = storeAt(tempDir("galgame-authstore-empty-"));
    await store.load();
    expect(store.listUsers()).toEqual([]);
    const r = await store.register("alice", "password123", { envCode: "invite-123", inviteCode: "invite-123", registrationOpen: true });
    expect(r.ok).toBe(true);
  });
});

describe("旧 users.json v1 迁移", () => {
  it("迁移到 auth.json v2：role=player，disabled→suspended；原文件保留", async () => {
    const dir = tempDir("galgame-authstore-migrate-");
    const legacy = {
      users: [
        { userId: "u1", username: "alice", passwordHash: "scrypt$16384$8$1$aa$bb", createdAt: 1, disabled: true },
        { userId: "u2", username: "bob", passwordHash: "scrypt$16384$8$1$cc$dd", createdAt: 2 },
      ],
    };
    await writeFile(path.join(dir, "users.json"), JSON.stringify(legacy), "utf8");
    const store = storeAt(dir);
    await store.load();
    expect(store.getUser("u1")).toMatchObject({ role: "player", state: "suspended" });
    expect(store.getUser("u2")).toMatchObject({ role: "player", state: "active" });
    // auth.json 已生成，旧文件保留
    const migrated = JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8")) as { version: number };
    expect(migrated.version).toBe(2);
    expect(JSON.parse(await readFile(path.join(dir, "users.json"), "utf8"))).toEqual(legacy);
  });
});

describe("注册 / 邀请原子性", () => {
  it("一次性邀请：成功扣减一次，复用被拒且不重复扣减", async () => {
    const store = storeAt(tempDir("galgame-authstore-invite-"));
    await store.load();
    const { invite, code } = await store.createInvite({ maxUses: 1 }, "admin");
    const ok = await store.register("bob", "password123", { envCode: "", inviteCode: code, registrationOpen: true });
    expect(ok.ok).toBe(true);
    expect(store.listInvites().find((i) => i.id === invite.id)?.used).toBe(1);
    const reuse = await store.register("carol", "password123", { envCode: "", inviteCode: code, registrationOpen: true });
    expect(reuse).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    expect(store.listInvites().find((i) => i.id === invite.id)?.used).toBe(1);
  });

  it("重复用户名不消耗邀请（原子回滚）", async () => {
    const store = storeAt(tempDir("galgame-authstore-dup-"));
    await store.load();
    await store.register("bob", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    const { invite, code } = await store.createInvite({}, "admin");
    const dup = await store.register("bob", "password123", { envCode: "", inviteCode: code, registrationOpen: true });
    expect(dup).toMatchObject({ ok: false, code: "E_ID_TAKEN" });
    expect(store.listInvites().find((i) => i.id === invite.id)?.used).toBe(0);
  });

  it("registrationOpen=false 拒绝注册；envCode 共享码不限次数", async () => {
    const store = storeAt(tempDir("galgame-authstore-open-"));
    await store.load();
    const closed = await store.register("bob", "password123", { envCode: "env", inviteCode: "env", registrationOpen: false });
    expect(closed).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    for (const name of ["alice", "bob", "carol"]) {
      expect((await store.register(name, "password123", { envCode: "env", inviteCode: "env", registrationOpen: true })).ok).toBe(true);
    }
  });

  it("重置凭证一次性：consumeReset 成功后复用失败", async () => {
    const store = storeAt(tempDir("galgame-authstore-reset-"));
    await store.load();
    const reg = await store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    if (!reg.ok) throw new Error("register failed");
    const issued = await store.issueReset(reg.user.userId, 60_000, "admin");
    if (!issued) throw new Error("issue failed");
    expect((await store.consumeReset("alice", issued.credential, "newpassword123")).ok).toBe(true);
    expect((await store.consumeReset("alice", issued.credential, "another12345")).ok).toBe(false);
    expect((await store.verify("alice", "newpassword123"))?.userId).toBe(reg.user.userId);
  });
});