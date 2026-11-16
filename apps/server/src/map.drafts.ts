/**
 * 地图草案引擎（docs/06 §5）：状态机 + AI 生成 + 发布落盘。
 *
 * 只读写 data/map/*.json；把场景装进房间世界状态是 MapService 的事（必须经 Arbiter）。
 * 生成失败重试一次仍失败时保持 approved 并记录 error，绝不降级成"半发布"。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { safeParseJson } from "../../../packages/llm/src/index.ts";
import type { LlmPort, LlmResult } from "../../../packages/shared/src/contract/types.ts";
import {
  CreateDraftBodySchema,
  LlmSceneOutputSchema,
  MapContent,
  ReviewBodySchema,
  codeOfError,
  fail,
  hex8,
  isMapFail,
  zodMessage,
} from "./map.data.ts";
import type {
  DraftHistoryEntry,
  DraftStatus,
  GeneratedScene,
  LlmSceneOutput,
  MapDraft,
  MapFail,
  PublishedScene,
  SceneDialogue,
  SceneLink,
  SceneTemplate,
  WorldMap,
} from "./map.data.ts";

export type DraftResult = { ok: true; draft: MapDraft } | MapFail;
export type DraftListResult = { ok: true; drafts: MapDraft[] } | MapFail;
export type PublishResult = { ok: true; draft: MapDraft; scene?: PublishedScene } | MapFail;

export interface DraftEngineDeps {
  content: MapContent;
  llm: LlmPort;
  adminToken: string;
  now?: () => number;
}

const REVIEW_FROM: readonly DraftStatus[] = ["pending_review"];
const PUBLISH_REJECT_FROM: readonly DraftStatus[] = ["approved", "generated_pending_review"];

interface DraftPick {
  draft: MapDraft;
  drafts: Map<string, MapDraft>;
}

export class DraftEngine {
  private readonly deps: DraftEngineDeps;
  private readonly now: () => number;

  constructor(deps: DraftEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async create(body: unknown): Promise<DraftResult> {
    const parsed = CreateDraftBodySchema.safeParse(body);
    if (!parsed.success) return fail("E_SCHEMA_INVALID", zodMessage(parsed.error));

    const { world, refs } = await this.deps.content.sceneRefs();
    const anchor = refs.get(parsed.data.anchorLocId);
    if (!anchor) return fail("E_SCENE_NOT_FOUND", `锚点场景 ${parsed.data.anchorLocId} 不存在`);

    const at = this.now();
    const draft: MapDraft = {
      id: `draft_${hex8()}`,
      status: "pending_review",
      name: parsed.data.name,
      idea: parsed.data.idea,
      anchorLocId: parsed.data.anchorLocId,
      coords: randomCoords(anchor.scene, world, parsed.data.x, parsed.data.y),
      history: [{ at, action: "create", actor: "player" }],
      createdAt: at,
      updatedAt: at,
    };
    const drafts = await this.deps.content.loadDrafts();
    drafts.set(draft.id, draft);
    await this.deps.content.saveDrafts(drafts);
    return { ok: true, draft: structuredClone(draft) };
  }

  async get(id: string): Promise<DraftResult> {
    const drafts = await this.deps.content.loadDrafts();
    const draft = drafts.get(id);
    if (!draft) return fail("E_REF_NOT_FOUND", `草案 ${id} 不存在`);
    return { ok: true, draft: structuredClone(draft) };
  }

  async list(token: string): Promise<DraftListResult> {
    const denied = this.authorize(token);
    if (denied) return denied;
    const drafts = await this.deps.content.loadDrafts();
    return {
      ok: true,
      drafts: [...drafts.values()].sort((a, b) => b.createdAt - a.createdAt).map((d) => structuredClone(d)),
    };
  }

  async review(id: string, token: string, body: unknown): Promise<DraftResult> {
    const denied = this.authorize(token);
    if (denied) return denied;
    const parsed = ReviewBodySchema.safeParse(body);
    if (!parsed.success) return fail("E_SCHEMA_INVALID", zodMessage(parsed.error));

    const found = await this.pick(id);
    if (isMapFail(found)) return found;
    const { draft, drafts } = found;
    if (!REVIEW_FROM.includes(draft.status)) {
      return fail("E_ILLEGAL_OP", `草案状态 ${draft.status} 不能走 review`);
    }
    const at = this.now();
    draft.status = parsed.data.action === "approve" ? "approved" : "rejected";
    record(draft, at, `review:${parsed.data.action}`, "admin", parsed.data.note);
    await this.deps.content.saveDrafts(drafts);
    return { ok: true, draft: structuredClone(draft) };
  }

  async publish(id: string, token: string, body: unknown): Promise<PublishResult> {
    const denied = this.authorize(token);
    if (denied) return denied;
    const parsed = ReviewBodySchema.safeParse(body);
    if (!parsed.success) return fail("E_SCHEMA_INVALID", zodMessage(parsed.error));

    const found = await this.pick(id);
    if (isMapFail(found)) return found;
    const { draft, drafts } = found;
    const at = this.now();

    if (parsed.data.action === "reject") {
      if (!PUBLISH_REJECT_FROM.includes(draft.status)) {
        return fail("E_ILLEGAL_OP", `草案状态 ${draft.status} 不能发布拒绝`);
      }
      draft.status = "rejected";
      record(draft, at, "publish:reject", "admin", parsed.data.note);
      await this.deps.content.saveDrafts(drafts);
      return { ok: true, draft: structuredClone(draft) };
    }

    // 场景 id 从草案 id 推导：draft_<8hex> → loc_user_<8hex>，便于从草案找回已发布场景
    const sceneId = `loc_user_${draft.id.slice("draft_".length)}`;
    const published = await this.deps.content.loadPublished();
    const existing = published.get(sceneId);
    if (existing) {
      // 发布是"写 published → 改草案状态"两步；若上次在中间崩溃，这里按已发布场景回填草案，避免卡死
      if (draft.status === "published") {
        return { ok: true, draft: structuredClone(draft), scene: structuredClone(existing) };
      }
      if (draft.status === "generated_pending_review") {
        draft.status = "published";
        record(draft, at, "publish:approve", "admin", parsed.data.note);
        await this.deps.content.saveDrafts(drafts);
        return { ok: true, draft: structuredClone(draft), scene: structuredClone(existing) };
      }
      return fail("E_ILLEGAL_OP", `场景 ${sceneId} 已存在，草案状态 ${draft.status} 不能发布`);
    }

    if (draft.status !== "generated_pending_review" || !draft.generated) {
      return fail("E_ILLEGAL_OP", `草案状态 ${draft.status} 不能发布（需先生成并通过审核）`);
    }
    const scene: PublishedScene = {
      id: sceneId,
      name: draft.generated.name,
      desc: draft.generated.desc,
      tags: draft.generated.tags,
      x: draft.coords.x,
      y: draft.coords.y,
      anchorLocId: draft.anchorLocId,
      links: draft.generated.links,
      dialogues: draft.generated.dialogues,
      publishedAt: at,
    };
    published.set(scene.id, scene);
    await this.deps.content.savePublished(published);

    draft.status = "published";
    record(draft, at, "publish:approve", "admin", parsed.data.note);
    await this.deps.content.saveDrafts(drafts);
    return { ok: true, draft: structuredClone(draft), scene: structuredClone(scene) };
  }

  /** 对 approved 草案触发 AI 生成；失败保持 approved + error（docs/06 §5） */
  async generate(id: string, token: string): Promise<DraftResult> {
    const denied = this.authorize(token);
    if (denied) return denied;

    const found = await this.pick(id);
    if (isMapFail(found)) return found;
    const { draft, drafts } = found;
    if (draft.status !== "approved") {
      return fail("E_ILLEGAL_OP", `草案状态 ${draft.status} 不能生成（需先审核通过）`);
    }

    draft.status = "generating";
    draft.error = undefined;
    record(draft, this.now(), "generate:start", "ai");
    await this.deps.content.saveDrafts(drafts);

    const result = await this.generateScene(draft);
    if (isMapFail(result)) {
      draft.status = "approved";
      draft.error = result.message;
      record(draft, this.now(), "generate:failed", "ai", result.message);
      await this.deps.content.saveDrafts(drafts);
      return { ok: false, code: result.code, message: result.message };
    }

    draft.status = "generated_pending_review";
    draft.generated = result.generated;
    draft.error = undefined;
    record(draft, this.now(), "generate:ok", "ai");
    await this.deps.content.saveDrafts(drafts);
    return { ok: true, draft: structuredClone(draft) };
  }

  private async pick(id: string): Promise<DraftPick | MapFail> {
    const drafts = await this.deps.content.loadDrafts();
    const draft = drafts.get(id);
    if (!draft) return fail("E_REF_NOT_FOUND", `草案 ${id} 不存在`);
    return { draft, drafts };
  }

  private authorize(token: string): MapFail | undefined {
    // 先固定长度哈希再比较，避免 `!==` 的短路时序泄露 token 前缀
    const given = createHash("sha256").update(token).digest();
    const expected = createHash("sha256").update(this.deps.adminToken).digest();
    if (!timingSafeEqual(given, expected)) return fail("E_FORBIDDEN", "管理员令牌无效");
    return undefined;
  }

  /** 共 2 次尝试（失败重试 1 次）；返回最后一次失败给调用方记录 */
  private async generateScene(draft: MapDraft): Promise<{ ok: true; generated: GeneratedScene } | MapFail> {
    let prompt: string;
    try {
      prompt = await this.deps.content.loadPrompt();
    } catch {
      return fail("E_MODULE_FAULT", "缺少提示词 content/prompts/map.scene.md");
    }
    let canonNpcIds: Set<string>;
    let knownSceneIds: Set<string>;
    try {
      canonNpcIds = await this.deps.content.loadCanonNpcIds();
      const { refs } = await this.deps.content.sceneRefs();
      knownSceneIds = new Set(refs.keys());
    } catch (e) {
      return fail("E_MODULE_FAULT", e instanceof Error ? e.message : String(e));
    }
    const user = [
      `场景名：${draft.name}`,
      `锚点场景：${draft.anchorLocId}（坐标 ${draft.coords.x},${draft.coords.y}）`,
      `玩家想法：${draft.idea}`,
      `已有 NPC id：${[...canonNpcIds].join("、") || "（无）"}`,
    ].join("\n");

    let last: MapFail = fail("E_LLM_FORMAT", "AI 生成失败");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.deps.llm.chat({
          json: true,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: user },
          ],
          maxTokens: 900,
        });
        const parsed = parseSceneOutput(res, canonNpcIds, knownSceneIds);
        if (isMapFail(parsed)) {
          last = parsed;
          continue;
        }
        return { ok: true, generated: materialize(parsed.value) };
      } catch (e) {
        last = fail(codeOfError(e), e instanceof Error ? e.message : String(e));
      }
    }
    return last;
  }
}

// ---------------------------------------------------------------- 纯函数（生成结果的边界处理）
function parseSceneOutput(
  res: LlmResult,
  canonNpcIds: Set<string>,
  knownSceneIds: Set<string>,
): { ok: true; value: LlmSceneOutput } | MapFail {
  let candidate: unknown = res.json;
  if (candidate === undefined) {
    const parsed = safeParseJson(res.raw);
    if (!parsed.ok) return fail("E_LLM_FORMAT", `模型输出不是合法 JSON：${parsed.message}`);
    candidate = parsed.value;
  }
  const zod = LlmSceneOutputSchema.safeParse(candidate);
  if (!zod.success) return fail("E_LLM_FORMAT", `生成结果不符合 schema：${zodMessage(zod.error)}`);
  for (const dialogue of zod.data.dialogues) {
    if (!canonNpcIds.has(dialogue.npcId)) {
      return fail("E_LLM_FORMAT", `对话引用了不存在的 NPC：${dialogue.npcId}`);
    }
  }
  for (const link of zod.data.links) {
    if (link.kind === "npc" && !canonNpcIds.has(link.id)) {
      return fail("E_LLM_FORMAT", `链接引用了不存在的 NPC：${link.id}`);
    }
    if (link.kind === "scene" && !knownSceneIds.has(link.id)) {
      return fail("E_LLM_FORMAT", `链接引用了不存在的场景：${link.id}`);
    }
  }
  return { ok: true, value: zod.data };
}

/** 分配 dlg_user_* id，并把对话型 links 从「模型乱填」重建成指向真实对话 id */
function materialize(value: LlmSceneOutput): GeneratedScene {
  const dialogues: SceneDialogue[] = value.dialogues.map((d) => ({
    id: `dlg_user_${hex8()}`,
    title: d.title,
    npcId: d.npcId,
    lines: d.lines,
  }));
  const links: SceneLink[] = value.links
    .filter((l) => l.kind !== "dialogue")
    .map((l) => (l.label === undefined ? { kind: l.kind, id: l.id } : { kind: l.kind, id: l.id, label: l.label }));
  for (const dialogue of dialogues) links.push({ kind: "dialogue", id: dialogue.id, label: dialogue.title });
  return { name: value.name, desc: value.desc, tags: value.tags, links: links.slice(0, 12), dialogues };
}

function randomCoords(
  anchor: SceneTemplate,
  world: WorldMap,
  x?: number,
  y?: number,
): { x: number; y: number } {
  const angle = Math.random() * Math.PI * 2;
  const radius = 40 + Math.random() * 50;
  const nx = x ?? anchor.x + Math.cos(angle) * radius;
  const ny = y ?? anchor.y + Math.sin(angle) * radius;
  const clamp = (v: number, max: number) => Math.round(Math.min(max, Math.max(0, v)));
  return { x: clamp(nx, world.width), y: clamp(ny, world.height) };
}

function record(draft: MapDraft, at: number, action: string, actor: DraftHistoryEntry["actor"], note?: string): void {
  const entry: DraftHistoryEntry = note === undefined ? { at, action, actor } : { at, action, actor, note };
  draft.history.push(entry);
  draft.updatedAt = at;
}
