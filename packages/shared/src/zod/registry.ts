/**
 * zod schema：Registry 数据文件的条目形状（attrs/events/intents/tools/ops）
 * 真源：contract/types.ts 的 AttrDef / EventDef / IntentDef / ToolDef / OpDef。
 * 引擎读 registry 决定"有哪些键"，代码里不出现具体属性名（I2 不变量）。
 */
import { z } from "zod";
import type { OpName } from "../contract/types.ts";
import { AttrValueSchema, EntityKindSchema, IdSchema } from "./entity.ts";
import { OpNameSchema } from "./op.ts";

/** 属性可见性：public=任何人可见、self=仅拥有者、secret=引擎强制通道注入 */
export const VisibilitySchema = z
  .enum(["public", "self", "secret"])
  .describe("属性可见性：public 所有人 / self 仅本人 / secret 只走强制注入通道");
export type VisibilityParsed = z.infer<typeof VisibilitySchema>;

export const AttrDisplaySchema = z
  .object({
    label: z.string().min(1).max(32).describe("面板显示名（中文）"),
    unit: z.string().max(8).optional().describe("单位，如 点 / 元 / cm"),
    hidden: z.boolean().optional().describe("true = 不给玩家渲染（仍参与裁决）"),
  })
  .describe("属性在面板上的渲染提示；前端只读 registry，不写死字段");
export type AttrDisplayParsed = z.infer<typeof AttrDisplaySchema>;

export const AttrDefSchema = z
  .object({
    key: IdSchema.describe("属性键；代码里只能通过这个字符串引用，不许出现字段名"),
    type: z.enum(["number", "string", "boolean"]).describe("值类型；决定 AttrValue 的合法分支"),
    scope: z.array(EntityKindSchema).min(1).describe("允许挂载的实体种类，跨种类不允许共用"),
    min: z.number().optional().describe("数值下界，Arbiter 钳制用"),
    max: z.number().optional().describe("数值上界，Arbiter 钳制用"),
    default: AttrValueSchema.optional().describe("实体创建时的默认值"),
    visibility: VisibilitySchema,
    display: AttrDisplaySchema,
  })
  .describe("属性定义：一条 = registry 里声明的一个键");
export type AttrDefParsed = z.infer<typeof AttrDefSchema>;

export const EventDefSchema = z
  .object({
    type: z.string().min(1).max(64).describe("领域事件名，点分小写，如 turn.patch"),
    when: z
      .string()
      .min(1)
      .max(200)
      .describe("触发条件的人类可读描述（给引擎作者看，不参与运行）"),
    broadcast: z.boolean().describe("true = 广播给全房间；false = 只进事件日志"),
  })
  .describe("领域事件声明（content/registry/events.json）");
export type EventDefParsed = z.infer<typeof EventDefSchema>;

export const IntentDefSchema = z
  .object({
    name: z.string().min(1).max(64).describe("意图名，如 trade.buy"),
    module: IdSchema.describe("声明该意图的模块 id"),
    examples: z.array(z.string().max(120)).max(12).optional().describe("玩家话术示例，供意图识别参考"),
  })
  .describe("意图声明：路由用，不在引擎里写 if (moduleId === ...)");
export type IntentDefParsed = z.infer<typeof IntentDefSchema>;

export const ToolDefSchema = z
  .object({
    name: z.string().min(1).max(96).describe("LLM 工具名：<moduleId>.<verb>"),
    module: IdSchema.describe("提供该工具的模块 id"),
    description: z.string().min(1).max(240).describe("给 LLM 看的工具说明（进提示词，改动要 bump PROMPT_VERSION）"),
    args: z.record(z.unknown()).describe("JSON Schema 形状的参数声明，由模块自己给"),
  })
  .describe("LLM 工具声明：function calling 的可调用清单");
export type ToolDefParsed = z.infer<typeof ToolDefSchema>;

export const OpDefSchema = z
  .object({
    name: OpNameSchema.describe("12 个原语之一，闭集"),
    args: z.record(z.unknown()).describe("参数形状声明（与 02-数据格式.md §4 对应）"),
    requires: z
      .enum(["attr", "entity", "plot", "none"])
      .optional()
      .describe("裁决前必须能查到的上下文类型；查不到直接拒"),
  })
  .describe("op 原语声明：列表必须恰好等于 12 个（check:contract 会验）");
export type OpDefParsed = z.infer<typeof OpDefSchema>;

/** 编译期校验：OpNameSchema 的取值范围必须与 OpName 相等 */
export const REGISTRY_OP_COVERAGE: OpName extends OpDefParsed["name"]
  ? OpDefParsed["name"] extends OpName
    ? true
    : never
  : never = true;
