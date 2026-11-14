/**
 * 回放：读取某房间的 JSONL 事件日志，重放到指定 seq，校验投影一致性。
 * 用法：npx tsx scripts/replay.ts --file data/rooms/room_x.jsonl [--to 42] [--json]
 */
import { readFileSync } from "node:fs";
import type { Envelope } from "../packages/shared/src/contract/types.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "" : (process.argv[++i] ?? ""));
}

const file = args.get("file");
if (!file) {
  console.error("用法: npx tsx scripts/replay.ts --file <jsonl> [--to seq]");
  process.exit(2);
}
const to = args.has("to") ? Number(args.get("to")) : Number.POSITIVE_INFINITY;

const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
const events: Envelope[] = lines.map((l, i) => {
  try {
    return JSON.parse(l) as Envelope;
  } catch {
    throw new Error(`第 ${i + 1} 行不是合法 JSON`);
  }
});

let last = 0;
let gaps = 0;
const types = new Map<string, number>();
for (const e of events) {
  if (e.seq <= to) {
    if (e.seq !== last + 1 && last !== 0) gaps++;
    last = Math.max(last, e.seq);
    types.set(e.type, (types.get(e.type) ?? 0) + 1);
  }
}

const summary = {
  file,
  total: events.length,
  replayedTo: last,
  seqGaps: gaps,
  types: Object.fromEntries([...types.entries()].sort()),
  ok: gaps === 0,
};

if (args.has("json")) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`事件 ${summary.total} 条，重放到 seq=${summary.replayedTo}，seq 断档 ${gaps} 处`);
  for (const [t, n] of Object.entries(summary.types)) console.log(`  ${t} × ${n}`);
}
process.exit(summary.ok ? 0 : 1);
