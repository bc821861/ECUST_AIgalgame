/**
 * 真机联调：用免费 ecust/超算 API 跑一个回合，验证网关与 JSON 约束。
 * 用法：GALGAME_LLM_BASE_URL=... GALGAME_LLM_MODEL=... GALGAME_LLM_API_KEY=... npx tsx scripts/live-check.ts
 * 不打印 key；只打印模型/耗时/叙事前 200 字与事件序列。
 */
import { createApp } from "../apps/server/src/bootstrap.ts";
import { loadConfig, hasLlm } from "../apps/server/src/config.ts";

const cfg = loadConfig();
if (!hasLlm(cfg)) {
  console.error("缺少 GALGAME_LLM_BASE_URL / GALGAME_LLM_API_KEY");
  process.exit(2);
}
console.log(`模型 ${cfg.llm.model} @ ${cfg.llm.baseUrl}`);
const app = await createApp(cfg);
const { roomId, actorId } = await app.createRoom("solo");
const t0 = Date.now();
const seen: string[] = [];
let narrative = "";
for await (const ev of app.turn.run({ roomId, actorId, input: "我去图书馆借一本旧期刊，顺便问问林老师最近有没有人来闹事", clientTurnId: `live_${t0}` })) {
  seen.push(ev.type);
  if (ev.type === "turn.delta") narrative += ev.text;
  if (ev.type === "turn.error" || ev.type === "turn.rejected") {
    console.error(`失败 ${ev.code}: ${ev.message}`);
    process.exit(1);
  }
  if (ev.type === "turn.commit") {
    console.log(`seq=${ev.seq} usage=${JSON.stringify(ev.usage ?? null)} 耗时=${Date.now() - t0}ms`);
  }
}
console.log("事件:", seen.join(" → "));
console.log("叙事:", narrative.slice(0, 200));
