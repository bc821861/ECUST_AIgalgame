/**
 * zod schema：实体 / 关系 / 世界状态（真源是 contract/types.ts，文档镜像见 docs/02-数据格式.md）
 * 规则：形状必须与 contract/types.ts 完全一致；加字段先改 types.ts（= 改契约）。
 */
import { z } from "zod";

// ---------------------------------------------------------------- 标量
export const IdSchema = z.string().min(1).max(96).describe("实体/记录 id；03 §0.3 约定 <kind>_<slug>");
export type IdParsed = z.infer<typeof IdSchema>;

export const ActorIdSchema = z
  .string()
  .min(1)
  .max(96)
  .describe("会行动的主体 id：玩家 plr_*、NPC npc_*，系统侧另有 sys");
export type ActorIdParsed = z.infer<typeof ActorIdSchema>;

export const EntityKindSchema = z
  .enum(["plr", "npc", "loc", "item", "fact", "lore", "plot"])
  .describe("实体种类，逐字对齐 03 §2.1");
export type EntityKindParsed = z.infer<typeof EntityKindSchema>;

export const AttrValueSchema = z
  .union([z.number().finite(), z.string(), z.boolean()])
  .describe("属性值只允许 number | string | boolean（03 §2.1）；x.* 区同样只允许这三类");
export type AttrValueParsed = z.infer<typeof AttrValueSchema>;

export const OriginSchema = z
  .enum(["seed", "ai", "system"])
  .describe("内容来源：seed=人工种子、ai=模型生成、system=引擎写入；AI 产出必须 canon:false");
export type OriginParsed = z.infer<typeof OriginSchema>;

export const EntityStatusSchema = z
  .enum(["active", "dormant", "tombstoned"])
  .describe("实体状态；tombstoned=软删除，id 永不复用");
export type EntityStatusParsed = z.infer<typeof EntityStatusSchema>;

export const PhaseSchema = z
  .enum(["morning", "noon", "afternoon", "evening", "night"])
  .describe("时段，逐字对齐 contract/types.ts Phase");
export type PhaseParsed = z.infer<typeof PhaseSchema>;

export const LinkKindSchema = z
  .enum(["knows", "owes", "holds", "present", "located_in", "member_of"])
  .describe("关系边类型：认识/欠人情/持有/在场/位于/属于；语义由契约固定");
export type LinkKindParsed = z.infer<typeof LinkKindSchema>;

// ---------------------------------------------------------------- Entity
export const EntitySchema = z
  .object({
    id: IdSchema,
    kind: EntityKindSchema,
    name: z.string().min(1).max(64).describe("显示名（中文可以），只用于表现层，不参与键值逻辑"),
    attrs: z
      .record(AttrValueSchema)
      .describe("属性表：键必须在 registry 声明，或以 x. 开头（x 区不校验类型、仅本房间可见）"),
    tags: z.array(z.string().max(32)).max(32).describe("检索用标签，不参与裁决"),
    origin: OriginSchema,
    canon: z.boolean().describe("人工锁定内容；AI 生成的内容一律 false，转正走 canonize"),
    status: EntityStatusSchema,
    createdAt: z.number().int().min(0).describe("创建时的游戏内回合序号（不是 wall clock）"),
    updatedAt: z.number().int().min(0).describe("最后变更的游戏内回合序号"),
    createdBy: IdSchema.optional().describe("创建者（actorId 或系统模块 id）"),
    tombstonedAt: z.number().int().min(0).optional().describe("被 tombstone 的回合序号"),
  })
  .describe("世界中的一个实体：玩家/NPC/地点/物品/事实/设定/剧情");
export type EntityParsed = z.infer<typeof EntitySchema>;

// ---------------------------------------------------------------- Link
export const LinkSchema = z
  .object({
    id: IdSchema,
    kind: LinkKindSchema,
    from: IdSchema.describe("起点实体 id"),
    to: IdSchema.describe("终点实体 id"),
    weight: z.number().min(0).max(100).optional().describe("关系强度 0~100，语义由 kind 决定"),
    audience: z
      .array(ActorIdSchema)
      .max(16)
      .optional()
      .describe("可见范围（不填或空 = 公开）；过滤在 Transport 层完成"),
    createdAt: z.number().int().min(0).describe("创建时的游戏内回合序号"),
    updatedAt: z.number().int().min(0).optional().describe("最后变更的回合序号"),
  })
  .describe("实体间的一条有向关系边；present 边由 scene.presentIds 重建");
export type LinkParsed = z.infer<typeof LinkSchema>;

// ---------------------------------------------------------------- 时钟 / 场景 / 房间
export const GameClockSchema = z
  .object({
    day: z.number().int().min(1).describe("游戏内第几天，从 1 开始"),
    phase: PhaseSchema,
    tick: z.number().int().min(0).describe("当天已推进行数，用于判定是否入夜"),
  })
  .describe("游戏内时钟：手工推进，不随真实时间流逝");
export type GameClockParsed = z.infer<typeof GameClockSchema>;

export const SceneStateSchema = z
  .object({
    locId: IdSchema.describe("当前地点实体 id"),
    presentIds: z
      .array(ActorIdSchema)
      .max(16)
      .describe("★ 在场者唯一真源；present 关系边由引擎据此重建，不要在别处维护"),
    props: z.array(IdSchema).max(32).optional().describe("场景中的道具实体 id"),
  })
  .describe("当前场景：地点 + 在场者 + 道具");
export type SceneStateParsed = z.infer<typeof SceneStateSchema>;

export const RoomMemberSchema = z
  .object({
    actorId: ActorIdSchema,
    role: z.enum(["player", "npc", "spectator"]).describe("房间内角色：玩家/由引擎驱动的 NPC/旁观"),
    joinedSeq: z.number().int().min(0).describe("加入时的房间 seq，用于断线续传对齐"),
    online: z.boolean().optional().describe("是否在线；离线成员的可见性由 04-联机与多Agent.md 规定"),
  })
  .describe("房间成员");
export type RoomMemberParsed = z.infer<typeof RoomMemberSchema>;

export const RoomStateSchema = z
  .object({
    id: IdSchema.describe("房间 id（room_*），seq 按房间维度单调递增"),
    mode: z.enum(["solo", "coop"]).describe("房间模式：solo=单人、coop=多人合作"),
    worldId: IdSchema.describe("canon 世界线 id；同 worldId 共享世界观但状态不共享"),
    members: z.array(RoomMemberSchema).max(16).describe("房间成员列表"),
    scene: SceneStateSchema.describe("当前场景"),
    idle: z.boolean().optional().describe("无在线玩家超过 room.idleReclaimMinutes 后置 true，可被回收"),
    createdAt: z.number().int().min(0).describe("创建时间（服务器毫秒时间戳）"),
    lastActiveAt: z.number().int().min(0).describe("最后活跃时间（服务器毫秒时间戳）"),
  })
  .describe("房间状态：隔离单位，单人=1 actor 的房间，联机=多个");
export type RoomStateParsed = z.infer<typeof RoomStateSchema>;

// ---------------------------------------------------------------- Plot
export const PlotSchema = z
  .object({
    id: IdSchema,
    goal: z.string().min(1).max(120).describe("这条线的目标（给导演与 NPC 剧本看，不给玩家）"),
    actors: z.array(ActorIdSchema).min(1).max(8).describe("参与者"),
    leverage: z.string().max(200).optional().describe("把柄/筹码，决定 NPC 为何配合"),
    risk: z.number().min(0).max(100).optional().describe("败露风险 0~100"),
    tone: z.string().max(40).optional().describe("基调（如 密谋/暧昧/竞争）"),
    leakPoints: z.array(z.string().max(80)).max(8).optional().describe("可被调查发现的痕迹（一句话/处）"),
    forbidReveal: z.string().max(200).optional().describe("绝不能直接说出的真相；只能通过 leakPoints 间接暴露"),
    status: z
      .enum(["active", "dormant", "resolved", "leaked"])
      .describe("open 线进行中 / dormant 暂停 / resolved 收束 / leaked 已败露"),
    guard: z
      .record(ActorIdSchema, z.number().min(0).max(100))
      .optional()
      .describe("参与者戒备值：0-20 自然 / 21-50 心虚 / 51-80 推脱 / 81+ 破裂"),
    createdDay: z.number().int().min(1).optional().describe("创建于第几天"),
  })
  .describe("一条剧情线（密谋/暧昧/竞争），玩家只能通过痕迹推断");
export type PlotParsed = z.infer<typeof PlotSchema>;

// ---------------------------------------------------------------- WorldState
export const WorldStateSchema = z
  .object({
    schemaVersion: z.number().int().min(1).describe("存档结构版本，当前为 SCHEMA_VERSION=2"),
    room: RoomStateSchema,
    entities: z.record(EntitySchema).describe("实体表 Record<实体 id, Entity>，键等于实体 id"),
    links: z.array(LinkSchema).max(512).describe("关系边列表；present 边由 scene.presentIds 重建"),
    clock: GameClockSchema,
    plots: z.array(PlotSchema).max(64).describe("本房间的剧情线"),
    moduleState: z
      .record(z.unknown())
      .describe("模块私有状态，key=moduleId；由各模块用自己的 zod schema 校验，引擎不解释"),
  })
  .describe("世界状态 = 事件日志的投影，只由 Arbiter 产出事件再投影，谁都不许直接改");
export type WorldStateParsed = z.infer<typeof WorldStateSchema>;
