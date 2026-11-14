/**
 * Arbiter 的逐 op 校验器：12 个原语一个 switch，只读状态、返回"该追加什么事件"。
 * 这里不写任何东西 —— 落库是 arbiter.ts 的事（I1：只有 Arbiter.apply 能改世界）。
 * 校验顺序即优先级：结构 → 引用存在 → canon 锁 → 属性注册 → 区间/clamp → x. 区限额 → 配额。
 */
import type {
  AttrDef, AttrValue, Entity, EntityKind, Envelope, LinkKind, OpName, Phase, Plot, Proposal, Registry, WorldState,
} from "../../shared/src/contract/types.ts";

export interface OpCtx {
  state: WorldState;
  registry: Registry;
  /** 发起信封：actorId 决定"谁在写"，type 用于识别引擎/tick 发起 */
  cause: Envelope;
}
export interface OpLimits {
  npc: number;
  loc: number;
  item: number;
  plots: number;
  presentMax: number;
  nameMax: number;
  tagsMax: number;
  xKeysPerEntity: number;
  maxDeltaPerTurn: number;
  memoryContentMax: number;
  memoryTagsMax: number;
}

export type Failure = { code: string; detail: string };
export type Emitted = { type: string; payload: unknown };

const KINDS = ["plr", "npc", "loc", "item", "fact", "lore", "plot"];
const LINKS = ["knows", "owes", "holds", "present", "located_in", "member_of"];
const PHASES: readonly Phase[] = ["morning", "noon", "afternoon", "evening", "night"];
/** 锁定"客观位置/归属"的边；主观认知边（knows/owes）允许变化，否则 canon 角色无法成长 */
const STRUCTURAL_LINKS = ["member_of", "located_in", "holds"];

const fail = (code: string, detail: string): Failure => ({ code, detail });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isXKey = (k: string): boolean => k.startsWith("x.");
/** canon 与玩家角色锁的是"身份"而不是数值 —— 否则玩家体力都不能掉 */
const locked = (e: Entity): boolean => e.kind === "plr" || e.canon;
function live(state: WorldState, id: string): Entity | undefined {
  const e = state.entities[id];
  return e && !e.tombstonedAt ? e : undefined;
}
/** 按 registry 声明把任意输入收敛成合法属性值；number 超界 clamp（02 §4：不报错，标 clamped） */
function asValue(def: AttrDef | undefined, value: unknown): { value: AttrValue; clamped: boolean } | Failure {
  if (!def) {
    if (isNum(value) || isStr(value) || isBool(value)) return { value, clamped: false };
    return fail("E_SCHEMA_INVALID", "x. 区属性值只能是 number/string/boolean");
  }
  if (def.type === "string") return isStr(value) ? { value, clamped: false } : fail("E_OUT_OF_RANGE", `${def.key} 需要 string`);
  if (def.type === "boolean") return isBool(value) ? { value, clamped: false } : fail("E_OUT_OF_RANGE", `${def.key} 需要 boolean`);
  if (!isNum(value)) return fail("E_OUT_OF_RANGE", `${def.key} 需要 number`);
  const clamped = (def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max);
  return { value: Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value)), clamped };
}

/** 单条校验 + 试算：通过返回事件，失败返回错误码（错误是数据，不抛异常） */
export function validateOp(
  op: OpName,
  a: Record<string, unknown>,
  ctx: OpCtx,
  proposal: Proposal,
  limits: OpLimits,
): { event: Emitted } | { fail: Failure } {
  const tick = ctx.state.clock.tick;
  const reg = ctx.registry;

  switch (op) {
    case "attr.delta": {
      if (!isId(a.entityId) || !isStr(a.key) || !isNum(a.delta)) return { fail: fail("E_SCHEMA_INVALID", "attr.delta 需要 {entityId,key,delta}") };
      const e = live(ctx.state, a.entityId);
      if (!e) return { fail: fail("E_ENTITY_MISSING", `实体 ${a.entityId} 不存在或已删除`) };
      const def = reg.attr(a.key);
      if (!def && !isXKey(a.key)) return { fail: fail("E_ATTR_UNKNOWN", `属性 ${a.key} 未在 attrs.json 声明`) };
      if (def && def.type !== "number") return { fail: fail("E_ATTR_UNKNOWN", `${a.key} 不是 number，不能用 delta`) };
      const budget = keyBudget(e, a.key, limits);
      if (budget) return { fail: budget };
      const from = isNum(e.attrs[a.key]) ? (e.attrs[a.key] as number) : isNum(def?.default) ? (def?.default as number) : 0;
      const cap = (def as (AttrDef & { maxDeltaPerTurn?: number }) | undefined)?.maxDeltaPerTurn ?? limits.maxDeltaPerTurn;
      const step = Math.min(Math.abs(a.delta), cap);
      const raw = from + Math.sign(a.delta) * step;
      const to = Math.min(def?.max ?? Infinity, Math.max(def?.min ?? -Infinity, raw));
      const clamped = to !== raw || step < Math.abs(a.delta);
      return { event: { type: "attr.changed", payload: { entityId: e.id, key: a.key, from, to, clamped } } };
    }
    case "attr.set": {
      if (!isId(a.entityId) || !isStr(a.key)) return { fail: fail("E_SCHEMA_INVALID", "attr.set 需要 {entityId,key,value}") };
      const e = live(ctx.state, a.entityId);
      if (!e) return { fail: fail("E_ENTITY_MISSING", `实体 ${a.entityId} 不存在或已删除`) };
      const def = reg.attr(a.key);
      if (!def && !isXKey(a.key)) return { fail: fail("E_ATTR_UNKNOWN", `属性 ${a.key} 未在 attrs.json 声明`) };
      const budget = keyBudget(e, a.key, limits);
      if (budget) return { fail: budget };
      const v = asValue(def, a.value);
      if ("code" in v) return { fail: v };
      return { event: { type: "attr.changed", payload: { entityId: e.id, key: a.key, from: e.attrs[a.key] ?? null, to: v.value, clamped: v.clamped } } };
    }
    case "entity.create": {
      const { id, kind, name } = a;
      if (!isId(id) || !isStr(kind) || !isStr(name)) return { fail: fail("E_SCHEMA_INVALID", "entity.create 需要 {id,kind,name}") };
      if (!KINDS.includes(kind)) return { fail: fail("E_SCHEMA_INVALID", `非法 kind ${kind}`) };
      if (!id.startsWith(`${kind}_`)) return { fail: fail("E_SCHEMA_INVALID", `id 必须以 ${kind}_ 开头（02 §3）`) };
      if (ctx.state.entities[id]) return { fail: fail("E_ID_TAKEN", `id ${id} 已被占用（永不复用）`) };
      if (name.length < 1 || name.length > limits.nameMax) return { fail: fail("E_OVER_LIMIT", `name 长度 1~${limits.nameMax}`) };
      if (a.canon === true) return { fail: fail("E_CANON_LOCKED", "AI/模块不能创建 canon 实体；转正走 canonize") };
      const quota = kind === "npc" ? limits.npc : kind === "loc" ? limits.loc : kind === "item" ? limits.item : 0;
      if (quota > 0) {
        const used = Object.values(ctx.state.entities).filter((x) => x.kind === kind && !x.tombstonedAt).length;
        if (used >= quota) return { fail: fail("E_QUOTA_EXCEEDED", `${kind} 配额 ${quota} 已满`) };
      }
      const tags = Array.isArray(a.tags) ? a.tags.filter(isStr) : [];
      if (tags.length > limits.tagsMax) return { fail: fail("E_OVER_LIMIT", `tags 最多 ${limits.tagsMax} 个`) };
      const attrs: Record<string, AttrValue> = {};
      if (a.attrs !== undefined) {
        if (!isObj(a.attrs)) return { fail: fail("E_SCHEMA_INVALID", "attrs 必须是对象") };
        for (const [k, v] of Object.entries(a.attrs)) {
          const def = reg.attr(k);
          if (!def && !isXKey(k)) return { fail: fail("E_ATTR_UNKNOWN", `属性 ${k} 未声明（必须走 registry）`) };
          const parsed = asValue(def, v);
          if ("code" in parsed) return { fail: parsed };
          attrs[k] = parsed.value;
        }
        if (Object.keys(attrs).filter(isXKey).length > limits.xKeysPerEntity) return { fail: fail("E_X_LIMIT", `单实体 x. 区最多 ${limits.xKeysPerEntity} 个 key`) };
      }
      const origin = a.origin === "seed" || a.origin === "system" ? a.origin : "ai";
      const entity: Entity = { id, kind: kind as EntityKind, name, attrs, tags, origin, canon: false, status: "active", createdAt: tick, updatedAt: tick };
      return { event: { type: "entity.created", payload: { entity } } };
    }
    case "entity.update": {
      if (!isId(a.entityId)) return { fail: fail("E_SCHEMA_INVALID", "entity.update 需要 entityId") };
      const e = live(ctx.state, a.entityId);
      if (!e) return { fail: fail("E_ENTITY_MISSING", `实体 ${a.entityId} 不存在或已删除`) };
      if (locked(e)) return { fail: fail("E_CANON_LOCKED", `${e.id} 是 canon/玩家实体，身份字段只读`) };
      const next: Entity = { ...e, updatedAt: tick };
      if (a.name !== undefined) {
        if (!isStr(a.name) || a.name.length < 1 || a.name.length > limits.nameMax) return { fail: fail("E_OVER_LIMIT", `name 长度 1~${limits.nameMax}`) };
        next.name = a.name;
      }
      if (a.tags !== undefined) {
        if (!Array.isArray(a.tags) || a.tags.length > limits.tagsMax) return { fail: fail("E_OVER_LIMIT", `tags 最多 ${limits.tagsMax} 个`) };
        next.tags = a.tags.filter(isStr);
      }
      if (a.status !== undefined) {
        if (a.status !== "active" && a.status !== "dormant") return { fail: fail("E_ILLEGAL_OP", "tombstoned 只能走 entity.tombstone") };
        next.status = a.status;
      }
      return { event: { type: "entity.updated", payload: { entity: next } } };
    }
    case "entity.tombstone": {
      if (!isId(a.entityId)) return { fail: fail("E_SCHEMA_INVALID", "entity.tombstone 需要 entityId") };
      const e = live(ctx.state, a.entityId);
      if (!e) return { fail: fail("E_ENTITY_MISSING", `实体 ${a.entityId} 不存在或已删除`) };
      if (locked(e)) return { fail: fail("E_CANON_LOCKED", `${e.id} 是 canon/玩家实体，不能删除`) };
      const p = ctx.state.plots.find((x) => x.status === "active" && x.actors.includes(e.id));
      if (p) return { fail: fail("E_REF_IN_USE", `仍在 plot ${p.id} 的演员表里，先收尾那条线`) };
      return { event: { type: "entity.tombstoned", payload: { entityId: e.id, reason: isStr(a.reason) ? a.reason : undefined, at: tick } } };
    }
    case "link.create": {
      if (!isStr(a.kind) || !LINKS.includes(a.kind)) return { fail: fail("E_SCHEMA_INVALID", `非法 link kind ${String(a.kind)}`) };
      if (a.kind === "present") return { fail: fail("E_ILLEGAL_OP", "present 边由引擎按 SceneState.presentIds 重建（02 §3.2）") };
      if (!isId(a.from) || !isId(a.to)) return { fail: fail("E_SCHEMA_INVALID", "link.create 需要 {kind,from,to}") };
      if (a.from === a.to) return { fail: fail("E_ILLEGAL_OP", "不能给自己建边") };
      if (!live(ctx.state, a.from)) return { fail: fail("E_REF_NOT_FOUND", `from ${a.from} 不存在`) };
      if (!live(ctx.state, a.to)) return { fail: fail("E_REF_NOT_FOUND", `to ${a.to} 不存在`) };
      const id = `link_${a.kind}_${a.from}__${a.to}`;
      if (ctx.state.links.some((l) => l.id === id)) return { fail: fail("E_IDEMPOTENT", `边 ${id} 已存在`) };
      let weight: number | undefined;
      if (a.weight !== undefined) {
        if (!isNum(a.weight)) return { fail: fail("E_SCHEMA_INVALID", "weight 必须是 number") };
        weight = Math.max(0, Math.min(100, a.weight));
      }
      const audience = Array.isArray(a.audience) ? a.audience.filter(isStr) : undefined;
      return { event: { type: "link.created", payload: { link: { id, kind: a.kind as LinkKind, from: a.from, to: a.to, weight, audience, createdAt: tick } } } };
    }
    case "link.remove": {
      const hit = ctx.state.links.find((l) => (isStr(a.linkId) ? l.id === a.linkId : l.kind === a.kind && l.from === a.from && l.to === a.to));
      if (!hit) return { fail: fail("E_REF_NOT_FOUND", "找不到匹配的边") };
      if (STRUCTURAL_LINKS.includes(hit.kind)) {
        const l = ctx.state.entities[hit.from];
        const r = ctx.state.entities[hit.to];
        if ((l && locked(l)) || (r && locked(r))) return { fail: fail("E_CANON_LOCKED", `结构性关系 ${hit.id} 由 canon 锁定`) };
      }
      return { event: { type: "link.removed", payload: { linkId: hit.id } } };
    }
    case "move.to": {
      if (!isId(a.actorId) || !isId(a.locId)) return { fail: fail("E_SCHEMA_INVALID", "move.to 需要 {actorId,locId}") };
      const actor = live(ctx.state, a.actorId);
      if (!actor) return { fail: fail("E_ENTITY_MISSING", `角色 ${a.actorId} 不存在`) };
      const loc = live(ctx.state, a.locId);
      if (!loc || loc.kind !== "loc") return { fail: fail("E_SCENE_NOT_FOUND", `地点 ${a.locId} 不存在`) };
      const fromLoc = ctx.state.links.find((l) => l.kind === "located_in" && l.from === actor.id)?.to ?? ctx.state.room.scene.locId;
      const adjacent =
        fromLoc === loc.id ||
        ctx.state.links.some((l) => l.kind === "located_in" && ((l.from === fromLoc && l.to === loc.id) || (l.from === loc.id && l.to === fromLoc)));
      if (!adjacent) return { fail: fail("E_NOT_ADJACENT", `${fromLoc} 与 ${loc.id} 不相邻`) };
      return { event: { type: "actor.moved", payload: { actorId: actor.id, from: fromLoc, to: loc.id } } };
    }
    case "time.advance": {
      const by = proposal.by ?? "";
      if (!by.startsWith("engine") && !by.startsWith("tick") && !ctx.cause.type.startsWith("tick")) {
        return { fail: fail("E_ILLEGAL_OP", "time.advance 只能由引擎/tick 发起") };
      }
      const clock = { ...ctx.state.clock };
      if (a.phase !== undefined) {
        if (!isStr(a.phase) || !PHASES.includes(a.phase as Phase)) return { fail: fail("E_SCHEMA_INVALID", `非法 phase ${String(a.phase)}`) };
        if (PHASES.indexOf(a.phase as Phase) <= PHASES.indexOf(clock.phase)) clock.day += 1;
        clock.phase = a.phase as Phase;
        clock.tick = 0;
      }
      const ticks = a.ticks === undefined ? (a.phase === undefined ? 1 : 0) : a.ticks;
      if (!isNum(ticks) || !Number.isInteger(ticks) || ticks < 0 || ticks > 24) return { fail: fail("E_SCHEMA_INVALID", "ticks 必须是 0~24 的整数") };
      clock.tick += ticks;
      return { event: { type: "clock.advanced", payload: { clock } } };
    }
    case "scene.set": {
      const locId = a.locId === undefined ? ctx.state.room.scene.locId : a.locId;
      if (!isId(locId)) return { fail: fail("E_SCHEMA_INVALID", "locId 必须是 id") };
      const loc = live(ctx.state, locId);
      if (!loc || loc.kind !== "loc") return { fail: fail("E_SCENE_NOT_FOUND", `地点 ${locId} 不存在`) };
      const presentIds = a.presentIds === undefined ? ctx.state.room.scene.presentIds : a.presentIds;
      if (!Array.isArray(presentIds) || !presentIds.every(isId)) return { fail: fail("E_SCHEMA_INVALID", "presentIds 必须是 id 数组") };
      if (presentIds.length > limits.presentMax) return { fail: fail("E_OVER_LIMIT", `在场者最多 ${limits.presentMax} 人`) };
      for (const pid of presentIds) if (!live(ctx.state, pid)) return { fail: fail("E_ENTITY_MISSING", `在场者 ${pid} 不存在`) };
      const props = Array.isArray(a.props) ? a.props.filter(isStr) : undefined;
      return { event: { type: "scene.changed", payload: { locId, presentIds, props } } };
    }
    case "memory.write": {
      if (!isId(a.ownerId) || !isStr(a.content)) return { fail: fail("E_SCHEMA_INVALID", "memory.write 需要 {ownerId,content}") };
      const owner = live(ctx.state, a.ownerId);
      if (!owner) return { fail: fail("E_ENTITY_MISSING", `记忆所有者 ${a.ownerId} 不存在`) };
      if (a.content.length < 1 || a.content.length > limits.memoryContentMax) return { fail: fail("E_OVER_LIMIT", `content 长度 1~${limits.memoryContentMax}`) };
      const by = proposal.by ?? "";
      const proxy = by.startsWith("engine") || by.startsWith("npc.") || ctx.cause.type.startsWith("tick");
      if (!proxy && owner.id !== ctx.cause.actorId) return { fail: fail("E_FORBIDDEN", "只能写自己的记忆（视角化写入由引擎骨架代写）") };
      const tags = Array.isArray(a.tags) ? a.tags.filter(isStr) : [];
      if (tags.length > limits.memoryTagsMax) return { fail: fail("E_OVER_LIMIT", `tags 最多 ${limits.memoryTagsMax} 个`) };
      const visibility = isStr(a.visibility) ? a.visibility : "private";
      if (!["private", "scene", "public"].includes(visibility)) return { fail: fail("E_SCHEMA_INVALID", `非法 visibility ${visibility}`) };
      const salience = isNum(a.salience) ? Math.max(0, Math.min(100, a.salience)) : 50;
      const memoryId = `mem_${owner.id}_${tick}_${tags.length}`;
      return { event: { type: "memory.written", payload: { memoryId, ownerId: owner.id, content: a.content, tags, salience, visibility, about: Array.isArray(a.about) ? a.about.filter(isStr) : undefined, at: tick } } };
    }
    case "plot.upsert": {
      if (!isStr(a.goal) || a.goal.length < 1) return { fail: fail("E_SCHEMA_INVALID", "plot.upsert 需要非空 goal") };
      if (!Array.isArray(a.actors) || a.actors.length < 2 || !a.actors.every(isId)) return { fail: fail("E_SCHEMA_INVALID", "actors 至少 2 个 id") };
      for (const actorId of a.actors) if (!live(ctx.state, actorId)) return { fail: fail("E_ENTITY_MISSING", `演员 ${actorId} 不存在`) };
      const id = isId(a.id) ? a.id : `plot_${tick}_${ctx.state.plots.length + 1}`;
      const existing = ctx.state.plots.find((p) => p.id === id);
      if (!existing && ctx.state.plots.filter((p) => p.status === "active").length >= limits.plots) {
        return { fail: fail("E_QUOTA_EXCEEDED", `同时 active 的 plot 最多 ${limits.plots} 条`) };
      }
      if (a.forbidReveal !== undefined && (!isStr(a.forbidReveal) || a.forbidReveal.length === 0)) return { fail: fail("E_SCHEMA_INVALID", "forbidReveal 不能为空串") };
      const guard: Record<string, number> = {};
      if (isObj(a.guard)) {
        for (const [who, v] of Object.entries(a.guard)) {
          if (!isNum(v)) return { fail: fail("E_SCHEMA_INVALID", `guard[${who}] 必须是 number`) };
          guard[who] = Math.max(0, Math.min(100, v));
        }
      }
      const status = a.status === "dormant" || a.status === "resolved" || a.status === "leaked" ? a.status : "active";
      const plot: Plot = {
        id,
        goal: a.goal,
        actors: a.actors as string[],
        leverage: isStr(a.leverage) ? a.leverage : existing?.leverage,
        risk: isNum(a.risk) ? Math.max(0, Math.min(100, a.risk)) : existing?.risk,
        tone: isStr(a.tone) ? a.tone : existing?.tone,
        leakPoints: Array.isArray(a.leakPoints) ? a.leakPoints.filter(isStr) : existing?.leakPoints,
        forbidReveal: isStr(a.forbidReveal) ? a.forbidReveal : existing?.forbidReveal,
        status,
        guard: Object.keys(guard).length > 0 ? guard : existing?.guard,
        createdDay: existing?.createdDay ?? ctx.state.clock.day,
      };
      return { event: { type: "plot.upserted", payload: { plot } } };
    }
  }
}

/** x. 区每实体 key 上限（02 §3：AI 临时属性也要有天花板，否则一场游戏能攒出几千个 key） */
function keyBudget(e: Entity, key: string, limits: OpLimits): Failure | undefined {
  if (!isXKey(key)) return undefined;
  const used = Object.keys(e.attrs).filter(isXKey).length;
  if (!(key in e.attrs) && used + 1 > limits.xKeysPerEntity) {
    return fail("E_X_LIMIT", `单实体 x. 区最多 ${limits.xKeysPerEntity} 个 key`);
  }
  return undefined;
}
