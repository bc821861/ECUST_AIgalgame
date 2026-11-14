/**
 * @galgame/testkit —— 模块作者的最小测试工具（纯内存）。
 *
 *   const ctx = makeCtx({ input: "去图书馆", registry: makeRegistry(attrs) });
 *
 * 默认状态里没有业务属性名（契约 I2：代码不硬编码属性），只放 x. 区示例值；
 * 需要真属性就用 makeRegistry(attrs) 声明后在测试里自己塞 attrs。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  type AttrDef,
  type Entity,
  type EventDef,
  type Id,
  type IntentDef,
  type ModuleContext,
  type OpDef,
  type Registry,
  type ToolDef,
  type WorldState,
} from "../../shared/src/index.ts";

export const SELF_ID = "plr_self";
export const DEFAULT_NPC_IDS = ["npc_lin", "npc_zhou"] as const;

/** 1 个玩家 + 2 个 NPC 的最小可玩世界；深拷贝，测试之间不共享引用。 */
export function makeRoom(): WorldState {
  const entities: Record<Id, Entity> = {};
  for (const e of [
    makeEntity(SELF_ID, "plr", "我"),
    makeEntity(DEFAULT_NPC_IDS[0], "npc", "林夏"),
    makeEntity(DEFAULT_NPC_IDS[1], "npc", "周野"),
  ]) {
    entities[e.id] = e;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    room: {
      id: "room_test",
      mode: "solo",
      worldId: "world_main",
      members: [
        { actorId: SELF_ID, role: "player", joinedSeq: 0 },
        { actorId: DEFAULT_NPC_IDS[0], role: "npc", joinedSeq: 0 },
        { actorId: DEFAULT_NPC_IDS[1], role: "npc", joinedSeq: 0 },
      ],
      scene: {
        locId: "loc_classroom",
        presentIds: [SELF_ID, DEFAULT_NPC_IDS[0], DEFAULT_NPC_IDS[1]],
      },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities,
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

export interface RegistryExtras {
  events?: readonly EventDef[];
  intents?: readonly IntentDef[];
  tools?: readonly ToolDef[];
  ops?: readonly OpDef[];
}

/** 由 attrs 声明构造只读 Registry；其余注册表默认空表。 */
export function makeRegistry(attrs: readonly AttrDef[] = [], extras: RegistryExtras = {}): Registry {
  const attrMap = new Map(attrs.map((a) => [a.key, a]));
  const eventMap = new Map((extras.events ?? []).map((e) => [e.type, e]));
  const intentMap = new Map((extras.intents ?? []).map((i) => [i.name, i]));
  const toolMap = new Map((extras.tools ?? []).map((t) => [t.name, t]));
  const opMap = new Map<string, OpDef>((extras.ops ?? []).map((o) => [o.name, o]));

  return {
    attr: (key) => attrMap.get(key),
    attrs: (scope) =>
      scope === undefined ? [...attrMap.values()] : [...attrMap.values()].filter((a) => a.scope.includes(scope)),
    event: (type) => eventMap.get(type),
    intent: (name) => intentMap.get(name),
    tool: (name) => toolMap.get(name),
    op: (name) => opMap.get(name),
    // 数据是内存里的常量，reload 保持接口形状即可
    reload: async () => {},
  };
}

/** 构造 ModuleContext；只传需要覆盖的字段，其余用默认最小世界。 */
export function makeCtx(overrides: Partial<ModuleContext> = {}): ModuleContext {
  const state = overrides.state ?? makeRoom();
  const registry = overrides.registry ?? makeRegistry();
  const clock = overrides.clock ?? state.clock;

  const query: ModuleContext["query"] = overrides.query ?? {
    entity: (id) => state.entities[id],
    attr: (entityId, key) => state.entities[entityId]?.attrs[key],
    present: () => [...state.room.scene.presentIds],
    links: (kind, from) =>
      state.links.filter((l) => (kind === undefined || l.kind === kind) && (from === undefined || l.from === from)),
  };

  return {
    roomId: overrides.roomId ?? state.room.id,
    actorId: overrides.actorId ?? SELF_ID,
    input: overrides.input ?? "",
    state,
    registry,
    clock,
    query,
    llm: overrides.llm ?? unconfiguredLlm,
    log: overrides.log ?? (() => {}),
  };
}

/** 建一个系统临时目录（自动纳入 tmpdir，无需手动清理）。 */
export function tempDir(prefix = "galgame-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 默认不联网：模块测试要 LLM 就显式传 `llm: new MockLlm(...)`。 */
const unconfiguredLlm = {
  chat: async (): Promise<never> => {
    throw new Error("makeCtx 未注入 llm：请传入 { llm: new MockLlm({...}) }");
  },
};

function makeEntity(id: Id, kind: Entity["kind"], name: string): Entity {
  return {
    id,
    kind,
    name,
    // x. 区不校验类型，适合放测试专用值（避免在代码里写死业务属性名）
    attrs: { "x.mood": "calm" },
    tags: [],
    origin: "seed",
    canon: false,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}
