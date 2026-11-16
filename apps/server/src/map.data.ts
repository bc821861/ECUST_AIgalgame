/**
 * 地图内容层：content 模板（只读）+ data/map/*.json（运行时草稿 / 发布库）。
 *
 * 只做 I/O 与 zod 边界校验；不碰 WorldState —— 世界状态只能由 Arbiter 写（见 map.ts）。
 * 文件形状与 docs/06 §2 一致；坐标/尺寸随 content/modules/map/data/world_map.json 走。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ErrorCode } from "../../../packages/shared/src/contract/errors.ts";
import { isErrorCode } from "../../../packages/shared/src/contract/errors.ts";

export const MAP_PROMPT_FILE = "map.scene.md";
export const MAP_PROMPT_VERSION = "map-scene-1";

/** 统一游戏层错误：Http 200 + ok:false；码只能取自契约闭集 */
export interface MapFail {
  ok: false;
  code: ErrorCode;
  message: string;
}

export function fail(code: ErrorCode, message: string): MapFail {
  return { ok: false, code, message };
}

export function isMapFail(v: unknown): v is MapFail {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

/** 交给 HTTP 层/调用方的异常码收敛：非契约码一律按引擎故障上报 */
export function codeOfError(e: unknown): ErrorCode {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (isErrorCode(code)) return code;
  }
  return "E_MODULE_FAULT";
}

/** 8 位十六进制后缀：draft_ / loc_user_ / dlg_user_ 共用，便于从草案 id 推出场景 id */
export function hex8(): string {
  return randomBytes(4).toString("hex");
}

export function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("；");
}

// ---------------------------------------------------------------- 内容形状（docs/06 §2）
export const SCENE_LINK_KINDS = ["module", "npc", "dialogue", "scene"] as const;

const SceneLinkSchema = z.object({
  kind: z.enum(SCENE_LINK_KINDS),
  id: z.string().min(1).max(64),
  label: z.string().max(60).optional(),
});
export type SceneLink = z.infer<typeof SceneLinkSchema>;

const SceneDialogueSchema = z.object({
  id: z.string().min(1).max(64),
  npcId: z.string().min(1).max(64),
  title: z.string().min(1).max(60),
  lines: z.array(z.string().min(1).max(300)).min(1).max(8),
});
export type SceneDialogue = z.infer<typeof SceneDialogueSchema>;

const SceneTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  desc: z.string().max(2000).default(""),
  tags: z.array(z.string().max(60)).max(16).default([]),
  x: z.number(),
  y: z.number(),
  links: z.array(SceneLinkSchema).max(12).default([]),
  dialogues: z.array(SceneDialogueSchema).max(8).default([]),
});
export type SceneTemplate = z.infer<typeof SceneTemplateSchema>;

const PublishedSceneSchema = SceneTemplateSchema.extend({
  anchorLocId: z.string().min(1).max(64),
  publishedAt: z.number(),
});
export type PublishedScene = z.infer<typeof PublishedSceneSchema>;

const WorldMapSchema = z.object({
  schemaVersion: z.number(),
  worldId: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  startLocId: z.string().min(1).max(64),
  scenes: z.array(SceneTemplateSchema).min(1),
});
export type WorldMap = z.infer<typeof WorldMapSchema>;

export interface SceneRef {
  scene: SceneTemplate;
  origin: "canon" | "user";
  anchorLocId?: string;
}

// ---------------------------------------------------------------- 草案形状（docs/06 §5）
export const DRAFT_STATUSES = [
  "pending_review",
  "approved",
  "generating",
  "generated_pending_review",
  "published",
  "rejected",
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

const DraftHistorySchema = z.object({
  at: z.number(),
  action: z.string().min(1).max(60),
  actor: z.enum(["player", "admin", "ai"]),
  note: z.string().max(300).optional(),
});
export type DraftHistoryEntry = z.infer<typeof DraftHistorySchema>;

/** 生成结果（已定稿）：dialogues 已分配 dlg_user_* id，links 已归一化 */
const GeneratedSceneSchema = z.object({
  name: z.string().min(2).max(24),
  desc: z.string().min(40).max(160),
  tags: z.array(z.string().max(60)).max(4),
  links: z.array(SceneLinkSchema).max(12),
  dialogues: z.array(SceneDialogueSchema).max(8),
});
export type GeneratedScene = z.infer<typeof GeneratedSceneSchema>;

const DraftSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(DRAFT_STATUSES),
  name: z.string().min(2).max(24),
  idea: z.string().min(10).max(300),
  anchorLocId: z.string().min(1).max(64),
  coords: z.object({ x: z.number(), y: z.number() }),
  generated: GeneratedSceneSchema.optional(),
  error: z.string().max(500).optional(),
  history: z.array(DraftHistorySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MapDraft = z.infer<typeof DraftSchema>;

const DraftsFileSchema = z.object({ schemaVersion: z.number(), drafts: z.array(DraftSchema) });
const PublishedFileSchema = z.object({ schemaVersion: z.number(), scenes: z.array(PublishedSceneSchema) });

// ---------------------------------------------------------------- 校验输入（HTTP / LLM 边界）
export const CreateDraftBodySchema = z.object({
  name: z.string().min(2, "场景名 2–24 字").max(24, "场景名 2–24 字"),
  idea: z.string().min(10, "想法 10–300 字").max(300, "想法 10–300 字"),
  anchorLocId: z.string().min(1).max(64),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});
export type CreateDraftBody = z.infer<typeof CreateDraftBodySchema>;

export const ReviewBodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(300).optional(),
});
export type ReviewBody = z.infer<typeof ReviewBodySchema>;

export const TravelBodySchema = z.object({
  locId: z.string().min(1).max(64),
  actorId: z.string().min(1).max(64).optional(),
});
export const TickBodySchema = z.object({ advance: z.boolean().optional() });
export const DialogueBodySchema = z.object({
  sceneId: z.string().min(1).max(64),
  dialogueId: z.string().min(1).max(64),
  actorId: z.string().min(1).max(64).optional(),
});

/** LLM 原始输出：dialogue 没有 id、covers 由服务端分配 */
export const LlmSceneOutputSchema = z.object({
  name: z.string().min(2).max(24),
  desc: z.string().min(40).max(160),
  tags: z.array(z.string().min(1).max(60)).max(4).default([]),
  links: z.array(SceneLinkSchema).max(12).default([]),
  dialogues: z
    .array(
      z.object({
        title: z.string().min(1).max(60),
        npcId: z.string().min(1).max(64),
        lines: z.array(z.string().min(1).max(300)).min(1).max(5),
      }),
    )
    .max(8)
    .default([]),
});
export type LlmSceneOutput = z.infer<typeof LlmSceneOutputSchema>;

const CanonSchema = z.object({
  npcs: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});

// ---------------------------------------------------------------- 文件仓库
async function readZod<S extends z.ZodTypeAny>(file: string, schema: S): Promise<z.output<S>> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} 不符合 schema：${zodMessage(parsed.error)}`);
  return parsed.data as z.output<S>;
}

export interface MapContentOptions {
  contentDir: string;
  dataDir: string;
}

/**
 * data/map/{drafts,published}.json 的懒加载 + 整文件原子写。
 * 运行时数据按 DATA_DIR 解析（测试用 tempDir），data/ 已 gitignore。
 */
export class MapContent {
  private readonly contentDir: string;
  private readonly dataDir: string;
  private worldMap: WorldMap | undefined;
  private canonNpcIds: Set<string> | undefined;
  private prompt: string | undefined;
  private published: Map<string, PublishedScene> | undefined;
  private drafts: Map<string, MapDraft> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: MapContentOptions) {
    this.contentDir = opts.contentDir;
    this.dataDir = opts.dataDir;
  }

  private get mapDir(): string {
    return path.join(this.dataDir, "map");
  }

  async loadWorldMap(): Promise<WorldMap> {
    this.worldMap ??= await readZod(
      path.join(this.contentDir, "modules", "map", "data", "world_map.json"),
      WorldMapSchema,
    );
    return this.worldMap;
  }

  async loadCanonNpcIds(): Promise<Set<string>> {
    if (!this.canonNpcIds) {
      const canon = await readZod(path.join(this.contentDir, "canon", "world.json"), CanonSchema);
      this.canonNpcIds = new Set(canon.npcs.map((n) => n.id));
    }
    return this.canonNpcIds;
  }

  async loadPrompt(): Promise<string> {
    this.prompt ??= await readFile(path.join(this.contentDir, "prompts", MAP_PROMPT_FILE), "utf8");
    return this.prompt;
  }

  async loadPublished(): Promise<Map<string, PublishedScene>> {
    if (!this.published) {
      const file = path.join(this.mapDir, "published.json");
      const data = await readZod(file, PublishedFileSchema).catch((e: unknown) => {
        // 文件还不存在是正常状态（第一个用户场景发布前），坏文件才抛
        if (e instanceof Error && e.message.includes("ENOENT")) return { schemaVersion: 1, scenes: [] };
        throw e;
      });
      this.published = new Map(data.scenes.map((s) => [s.id, s]));
    }
    return this.published;
  }

  async savePublished(scenes: Map<string, PublishedScene>): Promise<void> {
    this.published = scenes;
    await this.writeJson(path.join(this.mapDir, "published.json"), {
      schemaVersion: 1,
      scenes: [...scenes.values()],
    });
  }

  async loadDrafts(): Promise<Map<string, MapDraft>> {
    if (!this.drafts) {
      const file = path.join(this.mapDir, "drafts.json");
      const data = await readZod(file, DraftsFileSchema).catch((e: unknown) => {
        if (e instanceof Error && e.message.includes("ENOENT")) return { schemaVersion: 1, drafts: [] };
        throw e;
      });
      this.drafts = new Map(data.drafts.map((d) => [d.id, d]));
    }
    return this.drafts;
  }

  async saveDrafts(drafts: Map<string, MapDraft>): Promise<void> {
    this.drafts = drafts;
    await this.writeJson(path.join(this.mapDir, "drafts.json"), {
      schemaVersion: 1,
      drafts: [...drafts.values()],
    });
  }

  /** canon 模板优先；同 id 的已发布场景不覆盖 canon 数据 */
  async sceneRefs(): Promise<{ world: WorldMap; published: PublishedScene[]; refs: Map<string, SceneRef> }> {
    const [world, publishedMap] = await Promise.all([this.loadWorldMap(), this.loadPublished()]);
    const refs = new Map<string, SceneRef>();
    for (const scene of world.scenes) refs.set(scene.id, { scene, origin: "canon" });
    for (const scene of publishedMap.values()) {
      if (!refs.has(scene.id)) refs.set(scene.id, { scene, origin: "user", anchorLocId: scene.anchorLocId });
    }
    return { world, published: [...publishedMap.values()], refs };
  }

  /** 原子写：先写同目录临时文件再 rename，避免进程中断留下半截 JSON */
  private async writeJson(file: string, data: unknown): Promise<void> {
    const run = this.writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    this.writeChain = run.catch(() => undefined);
    await run;
  }
}
