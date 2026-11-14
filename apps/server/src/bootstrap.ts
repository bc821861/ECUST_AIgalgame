/**
 * 装配层：把 content/ 里的数据、packages/ 里的引擎、免费的 ecust/超算 API 接起来。
 * 这里是唯一知道"世界长什么样"的地方；引擎本身不认识任何具体名字。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Entity, Proposal, Registry } from "../../../packages/shared/src/index.ts";
import { CONTRACT_VERSION } from "../../../packages/shared/src/index.ts";
import {
  DefaultArbiter,
  DefaultTurn,
  DialogueHost,
  FileStore,
  InMemoryMemory,
  JsonRegistry,
  MemoryTransport,
  ModuleHost,
  buildView,
} from "../../../packages/engine/src/index.ts";
import { MockLlm, OpenAiCompatClient } from "../../../packages/llm/src/index.ts";
import type { ServerConfig } from "./config.ts";
import { hasLlm } from "./config.ts";
import type { AppDeps } from "./routes.ts";

interface CanonWorld {
  worldId: string;
  startLocId: string;
  locs: { id: string; name: string; exits?: string[] }[];
  npcs: { id: string; name: string; role?: string; traits?: string[]; locId?: string }[];
  facts?: { id: string; text: string }[];
}

const now = () => Date.now();

export async function createApp(cfg: ServerConfig): Promise<AppDeps> {
  const contentDir = path.resolve(cfg.contentDir);
  const canon = JSON.parse(await readFile(path.join(contentDir, "canon", "world.json"), "utf8")) as CanonWorld;

  const registry: Registry = new JsonRegistry(undefined, path.join(contentDir, "registry"));
  await registry.reload();

  const store = new FileStore(path.join(path.resolve(cfg.dataDir), "rooms"), {
    worldId: canon.worldId,
    locId: canon.startLocId,
  });

  const arbiter = new DefaultArbiter({ store, registry });
  const modules = new ModuleHost({ dir: path.join(contentDir, "modules") });
  await modules.load();

  const llm = hasLlm(cfg)
    ? new OpenAiCompatClient({
        baseUrl: cfg.llm.baseUrl,
        model: cfg.llm.model,
        apiKey: cfg.llm.apiKey,
        timeoutMs: cfg.llm.timeoutMs,
      })
    : new MockLlm({
        handler: (req) =>
          JSON.stringify({
            narrative: `（Mock 模式）你说了：「${req.messages[req.messages.length - 1]?.content ?? ""}」。配置 GALGAME_LLM_BASE_URL/API_KEY 后走真实模型。`,
            dialogue: "",
            proposals: [],
          }),
      });

  const memory = new InMemoryMemory();
  const transport = new MemoryTransport();
  const dialogue = new DialogueHost((spec) => ({
    roomId: spec.roomId,
    actorId: spec.participants[0] ?? "system",
    input: "",
    state: store.state(spec.roomId),
    registry,
    clock: store.state(spec.roomId).clock,
    query: {
      entity: (id) => store.state(spec.roomId).entities[id],
      attr: (id, key) => store.state(spec.roomId).entities[id]?.attrs[key],
      present: () => [...store.state(spec.roomId).room.scene.presentIds],
      links: (kind, from) => store.state(spec.roomId).links.filter((l) => (!kind || l.kind === kind) && (!from || l.from === from)),
    },
    llm,
    log: () => undefined,
  }));

  const turn = new DefaultTurn({ store, arbiter, registry, modules, memory, llm });

  return {
    store,
    turn,
    version: CONTRACT_VERSION,
    async createRoom(_mode) {
      const roomId = `room_${now().toString(36)}${Math.floor(Math.random() * 1e3).toString(36)}`;
      const actorId = "plr_self";
      const ts = now();

      // ① canon 由"内容加载器"直接写入事件日志（不是 AI/模块提案，所以不走 Arbiter 的 canon 锁）。
      //    这是唯一允许绕过 proposal 链的地方，且只在建房时发生一次。
      const seeded: Entity[] = [];
      const addSeed = (id: string, kind: Entity["kind"], name: string, canon: boolean, attrs: Entity["attrs"] = {}) => {
        seeded.push({ id, kind, name, attrs, tags: [], origin: canon ? "seed" : "system", canon, status: "active", createdAt: ts, updatedAt: ts });
      };
      for (const loc of canon.locs) addSeed(loc.id, "loc", loc.name, true);
      for (const npc of canon.npcs) addSeed(npc.id, "npc", npc.name, true);
      for (const f of canon.facts ?? []) addSeed(f.id, "fact", f.text, true);
      addSeed(actorId, "plr", "你", false);

      store.append(
        roomId,
        seeded.map((entity, i) => ({
          v: 1 as const,
          id: `evt_seed_${roomId}_${i}`,
          roomId,
          seq: i + 1,
          ts,
          actorId: "system",
          type: "entity.created",
          payload: { entity },
        })),
      );

      // ② 其余用普通提案（通路、出生点、在场），一样过 Arbiter 校验
      const ops: Proposal[] = [];
      for (const loc of canon.locs) {
        for (const to of loc.exits ?? []) {
          ops.push({ op: "link.create", args: { kind: "located_in", from: loc.id, to }, reason: "通路" });
        }
      }
      const startLoc = canon.startLocId ?? canon.locs[0]?.id;
      if (!startLoc) throw new Error("canon/world.json 缺少 locs");
      for (const npc of canon.npcs) {
        const loc = npc.locId ?? startLoc;
        ops.push({ op: "move.to", args: { actorId: npc.id, locId: loc }, reason: "初始位置" });
      }
      ops.push({ op: "move.to", args: { actorId, locId: startLoc }, reason: "出生点" });
      ops.push({ op: "scene.set", args: { locId: startLoc }, reason: "开场" });

      const seq = store.seq(roomId);
      const cause = { v: 1 as const, id: `evt_boot_${roomId}`, roomId, seq: seq + 1, ts: now(), actorId: "system", type: "room.bootstrap", payload: {} };
      const res = await arbiter.apply(roomId, ops, cause);
      if (!res.ok && res.rejected.length > 0) {
        // 建房时的坏数据是内容 bug，必须显式报出来，不能静默降级
        throw new Error(`建房间失败: ${JSON.stringify(res.rejected.slice(0, 3))}`);
      }
      return { roomId, actorId };
    },
  };
}

export { buildView };
