/**
 * 运行时模型接入（玩家自备 key）。
 *
 * 安全约定：
 * - key 不进日志、不回显；错误信息不携带 key；
 * - 提交后先探活一次（1 个 token 的 ping），失败不切换、返回可读原因；
 * - 接入成功后保存到 `data/llm-settings.json`（`/data/` 在 .gitignore 里）——明文、
 *   仅本机可见，重启后自动恢复；删除该文件 = 彻底忘记。环境变量 `GALGAME_LLM_*` 优先于保存的配置。
 *
 * 契约影响：`GET/POST/DELETE /api/v1/settings/llm` 三个端点，见 docs/03 §5.2.2。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmPort } from "../../../packages/shared/src/contract/types.ts";
import { OpenAiCompatClient } from "../../../packages/llm/src/index.ts";
import type { ErrorCode } from "../../../packages/shared/src/contract/errors.ts";
import { codeOfError } from "./map.data.ts";
import type { LlmSwitch } from "./llm-switch.ts";

export interface LlmSettingsView {
  mode: "offline" | "remote";
  baseUrl: string;
  model: string;
  /** 配置是否已落到本地文件（重启后仍生效）；环境变量配置的为 false */
  persisted: boolean;
}

export type LlmSettingsResult = { ok: true; view: LlmSettingsView } | { ok: false; code: ErrorCode; message: string };

export interface PersistedLlmSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const BodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(300),
  model: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().min(8).max(400),
});

export interface LlmSettingsOptions {
  sw: LlmSwitch;
  /** 断开时退回的实现（离线叙述器） */
  offline: LlmPort;
  /** 进程启动时从环境变量读到的配置（可能是空的 = 离线）；文件配置只在其缺位时生效 */
  initial: { mode: "offline" | "remote"; baseUrl: string; model: string; persisted: boolean };
  /** 持久化文件路径；null = 不落盘 */
  filePath: string | null;
  /**
   * 客户端工厂（测试注入口）：默认构造 OpenAiCompatClient。
   * 让"探活失败不切换"这类分支可以离线测试，不必真的联网。
   */
  clientFactory?: (cfg: { baseUrl: string; model: string; apiKey: string; timeoutMs: number }) => LlmPort;
}

/** 读取上次保存的配置；文件缺失/损坏都当没有，不让坏文件拖死启动 */
export async function loadPersistedLlmSettings(filePath: string): Promise<PersistedLlmSettings | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<PersistedLlmSettings>;
    if (typeof raw.baseUrl === "string" && typeof raw.model === "string" && typeof raw.apiKey === "string") {
      return { baseUrl: raw.baseUrl, model: raw.model, apiKey: raw.apiKey };
    }
    return null;
  } catch {
    return null;
  }
}

export class LlmSettings {
  private readonly sw: LlmSwitch;
  private readonly offline: LlmPort;
  private readonly filePath: string | null;
  private readonly clientFactory: (cfg: { baseUrl: string; model: string; apiKey: string; timeoutMs: number }) => LlmPort;
  private mode: "offline" | "remote";
  private baseUrl: string;
  private model: string;
  private persisted: boolean;

  constructor(opts: LlmSettingsOptions) {
    this.sw = opts.sw;
    this.offline = opts.offline;
    this.filePath = opts.filePath;
    this.clientFactory =
      opts.clientFactory ?? ((cfg) => new OpenAiCompatClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs }));
    this.mode = opts.initial.mode;
    this.baseUrl = opts.initial.baseUrl;
    this.model = opts.initial.model;
    this.persisted = opts.initial.persisted;
  }

  view(): LlmSettingsView {
    return { mode: this.mode, baseUrl: this.baseUrl, model: this.model, persisted: this.persisted };
  }

  /** 校验 → 探活 → 切换 → 落盘。失败时保持原实现与文件都不动。 */
  async apply(raw: unknown): Promise<LlmSettingsResult> {
    const parsed = BodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, code: "E_SCHEMA_INVALID", message: "接口地址 / 模型名 / API Key 必填（Key 至少 8 位）" };
    }
    const { baseUrl: rawBase, model } = parsed.data;
    // Key 常被复制坏：两端引号、行内空格、粘贴时的软换行。Key 本身不含空白，全部剥掉再校验。
    const apiKey = parsed.data.apiKey.replace(/^["']|["']$/g, "").replace(/\s+/g, "");
    if (apiKey.length < 8) {
      return { ok: false, code: "E_SCHEMA_INVALID", message: "API Key 看起来不完整（去除空格后不足 8 位），请从平台重新复制完整的一整串" };
    }
    // 宽容 URL：玩家经常把完整补全路径粘进来（…/api/v1/chat/completions），
    // 客户端自己会拼 /chat/completions，重复拼会 404。这里统一剥掉。
    const baseUrl = rawBase.replace(/\/+$/, "").replace(/\/(chat\/completions|completions)$/i, "");
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, code: "E_SCHEMA_INVALID", message: "接口地址必须以 http(s):// 开头" };
    }

    const client = this.clientFactory({ baseUrl, model, apiKey, timeoutMs: 15000 });
    try {
      // 探活：只让模型回一个词。失败原因可能是 key 错 / 端点错 / 网络不通，都归为连接失败。
      await client.chat({ messages: [{ role: "user", content: "只回复 ok" }], maxTokens: 8, temperature: 0 });
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).replaceAll(apiKey, "***");
      // 结果进服务端日志（不含 key），方便对照面板上的红字排查
      console.warn("[settings] 模型接入失败：", message.slice(0, 300));
      // 401/认证失败 = 平台明确拒绝了这把 key：给玩家指个路，别让他们猜
      const hint = /401|认证失败|无效|已禁用|Unauthorized/i.test(message)
        ? "（平台拒绝了这把 Key：请确认复制完整无空格、未过期，并且是发放给该端点的 key）"
        : "";
      return { ok: false, code: codeOfError(e), message: `连接失败：${message.slice(0, 200)}${hint}` };
    }

    this.sw.use(client);
    this.mode = "remote";
    this.baseUrl = baseUrl;
    this.model = model;

    // 落盘（临时文件 + 改名，避免写一半断电留下坏文件）；失败不阻断启用，只是重启后要重填
    this.persisted = await this.saveFile(apiKey);
    console.log(
      `[settings] 已接入模型 ${model} @ ${baseUrl}（${this.persisted ? "已保存，重启后仍生效" : "仅本次运行有效（保存失败）"}）`,
    );
    return { ok: true, view: this.view() };
  }

  /** 断开并删除保存的配置，退回离线叙述器 */
  async clear(): Promise<void> {
    this.sw.use(this.offline);
    this.mode = "offline";
    this.persisted = false;
    // 状态要"清干净"：断开后 GET 不应再看到旧地址/模型名（审阅建议项）
    this.baseUrl = "";
    this.model = "";
    if (this.filePath) {
      try {
        await rm(this.filePath, { force: true });
      } catch {
        // 删除失败只影响"忘记"这一步，不影响离线切换
      }
    }
    console.log("[settings] 已断开模型并清除本地保存，回到离线叙述");
  }

  private async saveFile(apiKey: string): Promise<boolean> {
    if (!this.filePath) return false;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      // mode 0o600：明文 key 只给文件属主读写；不依赖 umask（审阅 M3）
      await writeFile(tmp, JSON.stringify({ baseUrl: this.baseUrl, model: this.model, apiKey }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmp, this.filePath);
      return true;
    } catch (e) {
      console.warn("[settings] 配置保存失败（不影响本次启用）：", e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}
