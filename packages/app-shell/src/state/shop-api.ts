import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Магазин и VIP с сервера (docs/35-stage4-plan.md §3.6, WP10): витрина,
 * счёт на набор или подписку, продление VIP и его самоцветы дня, витрина
 * снаряжения за самоцветы. **Цены в
 * запросе нет** — только что покупают: сколько это стоит, решает сервер.
 *
 * Модуль грузится вместе с экраном магазина — первой загрузке он не нужен.
 *
 * Вид товара и ресурс состава — строками, а не перечислением: сервер новее
 * клиента может выставить то, чего клиент ещё не знает, и товар нарисуется
 * нейтрально, а не уронит витрину.
 */

const modeSchema = z.enum(["live", "test"]);

const itemSchema = z.object({
  sku: z.string(),
  kind: z.string(),
  contents: z.array(z.object({ resource: z.string(), amount: z.number() })),
  stars: z.nullable(z.number()),
  /** сколько спишется на самом деле: в тестовом режиме — звезда (Р14) */
  chargedStars: z.optional(z.nullable(z.number())),
  once: z.boolean(),
  owned: z.boolean(),
});

const shopSchema = z.object({ items: z.array(itemSchema), payable: z.boolean(), mode: z.optional(modeSchema) });

const invoiceSchema = z.object({
  purchaseId: z.string(),
  sku: z.string(),
  status: z.enum(["pending", "paid"]),
  invoiceUrl: z.nullable(z.string()),
  priceStars: z.number(),
  chargedStars: z.number(),
  mode: modeSchema,
});

const vipSchema = z.object({
  active: z.boolean(),
  until: z.nullable(z.string()),
  renewal: z.nullable(z.string()),
  canResume: z.boolean(),
  canOrder: z.boolean(),
  stars: z.nullable(z.number()),
  chargedStars: z.optional(z.nullable(z.number())),
  mode: z.optional(modeSchema),
  sku: z.optional(z.string()),
  periodDays: z.number(),
  daily: z.object({ gems: z.number(), claimed: z.boolean() }),
  /** во сколько раз больше награды дня, колеса, забега и заданий; сервер до надбавки поля не отдавал */
  rewardMul: z.optional(z.number()),
});

const dailySchema = z.object({ claimed: z.boolean(), gems: z.number(), view: vipSchema });

/** `fulfilled` — товар лёг на счёт; сервер до магазина поля не отдавал, и тогда хватает `granted`. */
const purchaseSchema = z.object({
  purchaseId: z.string(),
  status: z.enum(["pending", "paid", "refunded"]),
  granted: z.boolean(),
  fulfilled: z.optional(z.boolean()),
});

/** Витрина снаряжения: конкретные предметы суток, значения посчитаны сервером (Р11). */
const statSchema = z.object({ stat: z.string(), value: z.number() });
const showcaseOfferSchema = z.object({
  offerId: z.string(),
  slot: z.string(),
  rarity: z.string(),
  level: z.number(),
  power: z.number(),
  main: statSchema,
  extras: z.array(statSchema),
  gems: z.number(),
  sold: z.boolean(),
});
const showcaseSchema = z.object({ offers: z.array(showcaseOfferSchema) });
const showcaseBuySchema = z.object({ item: z.object({ itemId: z.string(), slot: z.string(), rarity: z.string(), level: z.number() }), view: showcaseSchema });

export type ShopView = z.infer<typeof shopSchema>;
export type ShowcaseView = z.infer<typeof showcaseSchema>;
export type ShowcaseOffer = z.infer<typeof showcaseOfferSchema>;
export type ShowcaseBuy = z.infer<typeof showcaseBuySchema>;
export type ShopItem = z.infer<typeof itemSchema>;
export type ShopInvoice = z.infer<typeof invoiceSchema>;
export type VipView = z.infer<typeof vipSchema>;
export type VipDaily = z.infer<typeof dailySchema>;
export type ShopPurchaseState = z.infer<typeof purchaseSchema>;

export interface ShopApi {
  view(): Promise<ApiResult<ShopView>>;
  order(sku: string): Promise<ApiResult<ShopInvoice>>;
  vip(): Promise<ApiResult<VipView>>;
  orderVip(): Promise<ApiResult<ShopInvoice>>;
  cancelVip(): Promise<ApiResult<VipView>>;
  resumeVip(): Promise<ApiResult<VipView>>;
  claimVipDaily(): Promise<ApiResult<VipDaily>>;
  purchase(purchaseId: string): Promise<ApiResult<ShopPurchaseState>>;
  showcase(): Promise<ApiResult<ShowcaseView>>;
  buyShowcase(offerId: string): Promise<ApiResult<ShowcaseBuy>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createShopApi(request: ApiRequest = apiRequest): ShopApi {
  return {
    view: () => request("/api/v1/shop", shopSchema, { method: "GET" }),
    order: (sku) => request("/api/v1/shop/orders", invoiceSchema, { method: "POST", body: { sku } }),
    vip: () => request("/api/v1/vip", vipSchema, { method: "GET" }),
    orderVip: () => request("/api/v1/vip/orders", invoiceSchema, { method: "POST" }),
    cancelVip: () => request("/api/v1/vip/cancel", vipSchema, { method: "POST" }),
    resumeVip: () => request("/api/v1/vip/resume", vipSchema, { method: "POST" }),
    claimVipDaily: () => request("/api/v1/vip/daily", dailySchema, { method: "POST" }),
    purchase: (purchaseId) => request(`/api/v1/payments/${encodeURIComponent(purchaseId)}`, purchaseSchema, { method: "GET" }),
    showcase: () => request("/api/v1/shop/showcase", showcaseSchema, { method: "GET" }),
    buyShowcase: (offerId) => request(`/api/v1/shop/showcase/${encodeURIComponent(offerId)}/buy`, showcaseBuySchema, { method: "POST" }),
  };
}

/** Магазин — только с входом: покупки и VIP сервер ведёт по аккаунту. */
export function shopAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/** Покупка дошла до игрока: у товара — лёг на счёт, у сервера до магазина — оплачен. */
export function isDelivered(state: ShopPurchaseState): boolean {
  return state.fulfilled ?? state.granted;
}
