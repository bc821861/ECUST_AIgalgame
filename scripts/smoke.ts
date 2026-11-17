/**
 * 冒烟：不联网、不花钱、不启服务器，直接跑一个回合。
 * 用法：npx tsx scripts/smoke.ts
 * 期望：建房 → 一次行动 → 事件序列 accepted/delta/patch/commit，退出码 0。
 */
import { createApp } from "../apps/server/src/bootstrap.ts";
import { loadConfig } from "../apps/server/src/config.ts";

const cfg = { ...loadConfig(), llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 5000 } };
const app = await createApp(cfg);
const seqOf = (room: string): number => (app.store as unknown as { seq(r: string): number }).seq(room);
const { roomId, actorId } = await app.createRoom("solo");

const before = await app.store.snapshot(roomId);
console.log(`房间 ${roomId}｜实体 ${Object.keys(before.entities).length}｜地点 ${before.entities[before.room.scene.locId]?.name ?? "?"}`);

const seen: string[] = [];
for await (const ev of app.turn.run({
  roomId,
  actorId,
  input: "我去图书馆看看",
  clientTurnId: "smoke_1",
  options: { skipLLM: false },
})) {
  seen.push(ev.type);
  if (ev.type === "turn.error" || ev.type === "turn.rejected") {
    console.error(`失败：${ev.type} ${ev.code} ${ev.message}`);
    process.exit(1);
  }
  if (ev.type === "turn.commit") console.log(`提交 seq=${ev.seq}`);
}

const after = await app.store.snapshot(roomId);
console.log("事件序列:", seen.join(" → "));
console.log(`实体变化: ${Object.keys(before.entities).length} → ${Object.keys(after.entities).length}`);

// 幂等：同一 clientTurnId 再来一次必须完全重放、不新增事件
const seqBefore = seqOf(roomId);
for await (const _ev of app.turn.run({ roomId, actorId, input: "重复提交", clientTurnId: "smoke_1" })) void _ev;
const seqAfter = seqOf(roomId);
if (seqAfter !== seqBefore) {
  console.error(`幂等失败：seq ${seqBefore} → ${seqAfter}`);
  process.exit(1);
}
console.log("幂等 OK（重复 clientTurnId 未产生新事件）");
