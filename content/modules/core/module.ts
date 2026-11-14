/**
 * core —— 基础行动模块（M0 示例）：move / look / say。
 * 说明：`core` 是 03 §0.2 的引擎保留命名空间；M0 先用它做兜底行动，
 * 正式版应把这三个工具收到引擎内置动作里，见交付报告里的未解决项。
 * 三种行动都只提议/返回事实，不做邻接判断（Arbiter 做）。
 */
import type {
  Entity,
  Module,
  ModuleContext,
  ModuleOutcome,
  Proposal,
} from "../../../packages/shared/src/contract/types.ts";

const BY = "mod.core";
const MOVE_RE = /去|到|往|走|回|进/;
const LOOK_RE = /看|观察|环顾|四周|有什么/;
const SAY_RE = /说|喊|叫|问|聊/;

/** 按中文名或 id 从世界状态里找地点；邻接由 Arbiter 校验，这里只认目标 */
function findLoc(ctx: ModuleContext, input: string): Entity | undefined {
  const locs = Object.values(ctx.state.entities).filter((e) => e.kind === "loc" && e.status === "active");
  return locs.find((e) => input.includes(e.name)) ?? locs.find((e) => input.includes(e.id));
}

function moveTo(ctx: ModuleContext, loc: Entity): ModuleOutcome {
  const proposals: Proposal[] = [
    { op: "move.to", args: { actorId: ctx.actorId, locId: loc.id }, reason: `前往${loc.name}`, by: BY },
  ];
  return { ok: true, proposals, facts: [`你动身去${loc.name}。`] };
}

function move(ctx: ModuleContext): ModuleOutcome {
  const loc = findLoc(ctx, ctx.input);
  if (!loc) return { ok: false, proposals: [], error: { code: "E_REF_NOT_FOUND", message: "没听出你要去哪儿" } };
  return moveTo(ctx, loc);
}

/** look 只产出事实，不产任何 op */
function look(ctx: ModuleContext): ModuleOutcome {
  const here = ctx.state.entities[ctx.state.room.scene.locId];
  const names = ctx.query.present().map((id) => ctx.query.entity(id)?.name ?? id);
  const facts = [`你在${here?.name ?? "一个不认识的角落"}。`, names.length > 0 ? `在场：${names.join("、")}。` : "没有别人在场。"];
  return { ok: true, proposals: [], facts };
}

/** say 只产生叙事；NPC 是否回应由对话导演决定，模块不写状态 */
function say(ctx: ModuleContext): ModuleOutcome {
  const text = ctx.input.replace(/^(我)?(说|喊|问|叫)[:：]?\s*/, "").trim() || ctx.input.trim();
  return { ok: true, proposals: [], facts: [`你说：「${text.slice(0, 200)}」`] };
}

const coreModule: Module = {
  intent(ctx) {
    if (MOVE_RE.test(ctx.input) && findLoc(ctx, ctx.input)) return move(ctx);
    if (LOOK_RE.test(ctx.input)) return look(ctx);
    if (SAY_RE.test(ctx.input)) return say(ctx);
    // 匹配不到就弃权，让 priority 更低（数值更大）的模块接手
    return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: "core 没匹配到可执行动作" } };
  },

  tool(name, args, ctx) {
    if (name === "core.move") {
      const a = (args ?? {}) as { locId?: string };
      const loc = a.locId ? ctx.query.entity(a.locId) : findLoc(ctx, ctx.input);
      if (!loc || loc.kind !== "loc") {
        return { ok: false, proposals: [], error: { code: "E_REF_NOT_FOUND", message: `找不到地点 ${String(a.locId)}` } };
      }
      return moveTo(ctx, loc);
    }
    if (name === "core.look") return look(ctx);
    if (name === "core.say") return say(ctx);
    return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: `core 不认识工具 ${name}` } };
  },
};

export default coreModule;
