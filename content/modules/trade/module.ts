/**
 * trade —— 校园小店模块（M0 示例）。只读 ctx、只算数、只返回 Proposal[]：
 * 价格合理、钱够不够、属性越界都由 Arbiter 裁决。数据见 data/shops.json。
 */
import type { Module, ModuleContext, ModuleOutcome, Proposal, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import shopsJson from "./data/shops.json" with { type: "json" };

interface Good { id: string; name: string; price: number; stock: number; effect?: { key: string; delta: number } }
interface Shop { id: string; name: string; locId: string; goods: Good[] }

const SHOPS = (shopsJson as { shops: Shop[] }).shops;
const BY = "mod.trade";

/** 当前地点的小店；不在店里就没有交易可做 */
function shopHere(ctx: ModuleContext): Shop | undefined {
  return SHOPS.find((s) => s.locId === ctx.state.room.scene.locId);
}

/** 从自然语言里认商品：先匹配中文名，再退化成 id */
function matchGood(shop: Shop, input: string): Good | undefined {
  return shop.goods.find((g) => input.includes(g.name)) ?? shop.goods.find((g) => input.includes(g.id));
}

/** 手上属于该商品的条目：借 holds 边查，不读模块私有状态 */
function heldItemOf(ctx: ModuleContext, goodId: string): string | undefined {
  const tag = `good:${goodId}`;
  return ctx.query.links("holds", ctx.actorId).map((l) => l.to).find((id) => ctx.query.entity(id)?.tags.includes(tag));
}

/** 引擎没有 id 生成器：用 day/tick 拼稳定 id，同回合重复购买会被 E_ID_TAKEN 拒绝（可接受） */
function itemIdOf(ctx: ModuleContext, good: Good): string {
  return `item_${good.id}_d${ctx.clock.day}t${ctx.clock.tick}`;
}

function shopView(shop: Shop): ViewPatch {
  const items = shop.goods.map((g) => ({ key: g.id, text: `${g.name} · ${g.price} 元`, meta: { stock: g.stock } }));
  return { lists: [{ id: "shop", title: shop.name, items }] };
}

function browse(shop: Shop): ModuleOutcome {
  const priceList = shop.goods.map((g) => `${g.name} ${g.price} 元`).join("、");
  return { ok: true, proposals: [], facts: [`${shop.name}在售：${priceList}`], ui: shopView(shop) };
}

function buy(ctx: ModuleContext, shop: Shop, good: Good, qty: number): ModuleOutcome {
  const itemId = itemIdOf(ctx, good);
  const proposals: Proposal[] = [
    { op: "attr.delta", args: { entityId: ctx.actorId, key: "money", delta: -good.price * qty }, reason: `向${shop.name}买${good.name}`, by: BY },
    { op: "entity.create", args: { id: itemId, kind: "item", name: good.name, tags: [`good:${good.id}`, `shop:${shop.id}`], origin: "system", canon: false }, reason: `买到的${good.name}`, by: BY },
    { op: "link.create", args: { kind: "holds", from: ctx.actorId, to: itemId }, reason: "入手", by: BY },
  ];
  if (good.effect) {
    proposals.push({ op: "attr.delta", args: { entityId: ctx.actorId, key: good.effect.key, delta: good.effect.delta * qty }, reason: `${good.name}的效果`, by: BY });
  }
  return { ok: true, proposals, facts: [`你付了 ${good.price * qty} 元，拿到${good.name}。`], ui: shopView(shop) };
}

function sell(ctx: ModuleContext, good: Good): ModuleOutcome {
  const itemId = heldItemOf(ctx, good.id);
  if (!itemId) return { ok: false, proposals: [], error: { code: "E_REF_NOT_FOUND", message: `你手上没有${good.name}` } };
  const refund = Math.floor(good.price / 2);
  return {
    ok: true,
    proposals: [
      { op: "entity.tombstone", args: { entityId: itemId, reason: `退回${good.name}` }, by: BY },
      { op: "attr.delta", args: { entityId: ctx.actorId, key: "money", delta: refund }, reason: `退回${good.name}`, by: BY },
    ],
    facts: [`${good.name}退掉，拿回 ${refund} 元。`],
  };
}

const tradeModule: Module = {
  init() {
    // 数据自洽性检查失败 → 模块 unhealthy 被隔离，不拖垮引擎
    for (const shop of SHOPS) {
      if (!shop.id || !shop.locId || shop.goods.length === 0) throw new Error(`trade: 小店数据不完整 ${shop.id}`);
    }
  },

  intent(ctx) {
    const shop = shopHere(ctx);
    if (!shop) return { ok: false, proposals: [], error: { code: "E_SCENE_NOT_FOUND", message: "这里没有小店" } };
    const good = matchGood(shop, ctx.input);
    if (/卖|退/.test(ctx.input)) {
      return good ? sell(ctx, good) : { ok: false, proposals: [], error: { code: "E_REF_NOT_FOUND", message: "没说清要退哪件" } };
    }
    if (/买|来|要|拿/.test(ctx.input)) {
      if (!good) return browse(shop); // 没说买什么 → 先给清单，不猜
      const qty = Math.max(1, Math.trunc(Number(/(\d+)\s*[个件瓶杯份]/.exec(ctx.input)?.[1] ?? 1)));
      return buy(ctx, shop, good, qty);
    }
    return browse(shop);
  },

  tool(name, args, ctx) {
    if (name !== "trade.buy") return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: `trade 不认识工具 ${name}` } };
    const shop = shopHere(ctx);
    if (!shop) return { ok: false, proposals: [], error: { code: "E_SCENE_NOT_FOUND", message: "这里没有小店" } };
    const a = (args ?? {}) as { goodId?: string; qty?: number };
    const good = shop.goods.find((g) => g.id === a.goodId);
    if (!good) return { ok: false, proposals: [], error: { code: "E_REF_NOT_FOUND", message: `本店没有 ${String(a.goodId)}` } };
    return buy(ctx, shop, good, Math.max(1, Math.trunc(a.qty ?? 1)));
  },

  view(ctx) {
    const shop = shopHere(ctx);
    return shop ? shopView(shop) : null;
  },
};

export default tradeModule;
