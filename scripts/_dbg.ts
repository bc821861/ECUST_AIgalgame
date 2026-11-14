import path from "node:path";
import { DefaultArbiter, EventSourcedStore, JsonRegistry } from "../packages/engine/src/index.ts";
const registry = new JsonRegistry(undefined, path.join(process.cwd(), "content/registry"));
await registry.reload();
const store = new EventSourcedStore({ worldId: "ecust_campus", locId: "loc_library" });
const arbiter = new DefaultArbiter({ store, registry });
const roomId = "room_dbg";
const cause = { v: 1 as const, id: "e1", roomId, seq: 1, ts: Date.now(), actorId: "system", type: "room.bootstrap", payload: {} };
const res = await arbiter.apply(roomId, [
  { op: "entity.create", args: { id: "loc_library", kind: "loc", name: "图书馆", canon: true, origin: "seed", attrs: {}, tags: [] }, reason: "t" },
  { op: "entity.create", args: { id: "plr_self", kind: "plr", name: "你", canon: false, origin: "system", attrs: {}, tags: [] }, reason: "t" },
], cause);
console.log(JSON.stringify(res.rejected, null, 2));
console.log("entities:", Object.keys((await store.snapshot(roomId)).entities));
