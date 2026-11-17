/**
 * 模型接入设置的回归测试（审阅 M2/M3）：
 * 覆盖 GET/POST/DELETE 语义、key 不回显、探活失败不切换、文件往返、clear 重置、仅本机守卫。
 * 全部离线：探活用注入的假客户端，不联网。
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import type { LlmPort, LlmRequest, LlmResult } from "../../../packages/shared/src/contract/types.ts";
import { LlmError } from "../../../packages/llm/src/index.ts";
import { LlmSwitch } from "./llm-switch.ts";
import { LlmSettings, loadPersistedLlmSettings } from "./settings.ts";
import { registerRoutes } from "./routes.ts";

const KEY = "sk-test-key-0123456789abcdef";
const OK_RESULT: LlmResult = { raw: "ok", usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "test", latencyMs: 1 };

function portOf(chat: (req: LlmRequest) => Promise<LlmResult>): LlmPort {
  return { chat };
}

function offlinePort(): LlmPort {
  return portOf(async () => ({ ...OK_RESULT, raw: "offline" }));
}

async function makeSettings(probeOk: boolean) {
  const filePath = path.join(tempDir("galgame-settings-test-"), "llm-settings.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  const offline = offlinePort();
  const probePort = portOf(async () => {
    if (!probeOk) throw new LlmError("E_LLM_FORMAT", `401 ${KEY} 认证失败`);
    return OK_RESULT;
  });
  const sw = new LlmSwitch(offline);
  const settings = new LlmSettings({
    sw,
    offline,
    filePath,
    initial: { mode: "offline", baseUrl: "", model: "", persisted: false },
    clientFactory: () => probePort,
  });
  return { settings, offline, probePort, sw, filePath };
}

const BODY = { baseUrl: "https://example.test/api/v1", model: "test-model", apiKey: KEY };

describe("LlmSettings", () => {
  it("探活失败：不切换、不落盘、错误信息不含 key", async () => {
    const { settings, offline, sw, filePath } = await makeSettings(false);
    const r = await settings.apply(BODY);

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, code: "E_LLM_FORMAT" });
    if (r.ok) return;
    expect(r.message).not.toContain(KEY);
    expect(sw.current()).toBe(offline); // 没切换
    await expect(readFile(filePath, "utf8")).rejects.toThrow(); // 没落盘
  });

  it("探活成功：切换、落盘（0600）、view 不回显 key、文件可往返", async () => {
    const { settings, probePort, sw, filePath } = await makeSettings(true);
    const r = await settings.apply(BODY);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view).toEqual({ mode: "remote", baseUrl: "https://example.test/api/v1", model: "test-model", persisted: true });
    expect(JSON.stringify(r.view)).not.toContain(KEY);
    expect(sw.current()).toBe(probePort);

    const saved = await loadPersistedLlmSettings(filePath);
    expect(saved).toEqual({ baseUrl: "https://example.test/api/v1", model: "test-model", apiKey: KEY });
    // 明文 key 文件必须是属主可读写（mode 600）
    if (process.platform !== "win32") {
      const m = await stat(filePath);
      expect(m.mode & 0o777).toBe(0o600);
    }
  });

  it("clear：回离线、删文件、view 清空地址与模型名", async () => {
    const { settings, offline, sw, filePath } = await makeSettings(true);
    await settings.apply(BODY);
    await settings.clear();

    expect(sw.current()).toBe(offline);
    expect(settings.view()).toEqual({ mode: "offline", baseUrl: "", model: "", persisted: false });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    await rm(path.dirname(filePath), { recursive: true, force: true });
  });
});

describe("settings 路由：仅本机", () => {
  async function makeApp() {
    const { settings } = await makeSettings(true);
    const app = Fastify();
    registerRoutes(app, {
      store: {},
      turn: {},
      map: {},
      settings,
      createRoom: async () => ({ roomId: "r", actorId: "a" }),
      version: "test",
    } as never);
    await app.ready();
    return app;
  }

  it("本机请求放行", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/llm" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("非本机 IP 一律 E_FORBIDDEN", async () => {
    const app = await makeApp();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/api/v1/settings/llm",
        remoteAddress: "203.0.113.9",
        payload: method === "POST" ? BODY : undefined,
      });
      expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    }
    await app.close();
  });
});
