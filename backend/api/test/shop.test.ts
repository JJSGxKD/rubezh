import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { SHOP_SKUS, TITLE_MAX, contentsOf, shopSkuSchema, skuById } from "../src/modules/shop/shop-catalog.js";
import { ShopController } from "../src/modules/shop/shop.controller.js";
import { ShopPromoService } from "../src/modules/shop/shop-promo.service.js";
import { ShopService } from "../src/modules/shop/shop.service.js";
import { ShowcaseService } from "../src/modules/shop/showcase.service.js";
import { badgesOf, gemValuePct, recommendedSku } from "../src/modules/shop/shop-marketing.js";
import type { ItemsService } from "../src/modules/items/items.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { MemoryShopPromoRepository } from "./helpers/memory-shop-promos.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * Магазин (docs/35-stage4-plan.md §3.6, WP10): каталог держит границу с
 * гачей схемой; цену решает сервер; разовый товар покупается однажды;
 * оплаченное ложится на счёт игрока ключом покупки — и после повтора
 * задания подтверждения, и после повтора обновления площадки.
 */

const NOW = Date.UTC(2026, 8, 30, 9);

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

function player(platform: AccountRef["platform"] = "telegram", platformUserId = "555000222"): AccountRef {
  return { accountId: randomUUID(), platform, platformUserId };
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  private readonly keys = new Set<string>();
  failNext = false;

  async grant(input: GrantInput): Promise<GrantResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("кошелёк недоступен");
    }
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) {
      this.keys.add(input.idempotencyKey);
      this.grants.push(input);
    }
    return { credited: input.amount, balance: 0, duplicate };
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

/** Надетое игрока и ссылка Tribute из панели — то, от чего магазин подбирает подачу. */
class Context {
  equipped = 0;
  tribute = "";
}

function setup(settings = config()) {
  const purchases = new MemoryPurchasesRepository();
  const api = new FakeStarsApi();
  const providers = starsProviders(api);
  const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
  const fulfillment = new PurchaseFulfillment();
  const wallet = new FakeWallet();
  const context = new Context();
  const items = { inventory: async () => ({ equipped: Object.fromEntries(Array.from({ length: context.equipped }, (_, index) => [`slot${String(index)}`, "item"])) }) };
  const reader: SettingsReader = { get: (setting) => (setting.key === SETTINGS.shopTributeUrl.key ? setting.schema.parse(context.tribute) : setting.fallback), onChange: () => undefined };
  const promoRows = new MemoryShopPromoRepository();
  const promos = new ShopPromoService(promoRows, new RolesService(settings, new MemoryRolesRepository(), new MemoryAccountRepository()));
  const shop = new ShopService(payments, fulfillment, wallet as unknown as WalletService, items as unknown as ItemsService, promos, reader);
  shop.onModuleInit();
  const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings));
  const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers), new RunsHooks(), providers, fulfillment, purchases);
  return { purchases, api, shop, wallet, queue, context, promoRows };
}

/** Площадка подтвердила оплату — задание очереди, как его выполнил бы воркер. */
async function pay(ctx: ReturnType<typeof setup>, purchaseId: string, payer: string, chargeId = `charge-${purchaseId}`): Promise<void> {
  const row = await ctx.purchases.byId(purchaseId);
  if (row === null) throw new Error("нет покупки");
  // В базе получатель возврата — из аккаунта покупки.
  ctx.purchases.owners.set(row.accountId, payer);
  await ctx.queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: purchaseId, payerId: payer, currency: "XTR", totalAmount: row.chargedStars } } });
}

describe("каталог магазина", () => {
  it("каждый товар проходит схему: состав — только ресурсы в точных количествах, id не повторяются, название влезает в окно оплаты", () => {
    for (const sku of SHOP_SKUS) {
      expect(shopSkuSchema.safeParse(sku).success, sku.id).toBe(true);
      expect(sku.title.length, sku.id).toBeLessThanOrEqual(TITLE_MAX);
      expect(contentsOf(sku).length, sku.id).toBeGreaterThan(0);
    }
    expect(new Set(SHOP_SKUS.map((sku) => sku.id)).size).toBe(SHOP_SKUS.length);
  });

  it("граница с гачей (Р11): случайное содержимое, лишнее поле и пустой набор схема не пропустит", () => {
    const base = SHOP_SKUS[0];
    if (base === undefined) throw new Error("каталог пуст");
    for (const bad of [
      { ...base, contents: { gems: 10 }, lootTable: "chest_epic" },
      { ...base, contents: { randomItem: 1 } },
      { ...base, contents: { gems: 1.5 } },
      { ...base, contents: {} },
      { ...base, stars: 0 },
      { ...base, title: "Очень длинное название набора сверх окна" },
    ]) {
      expect(shopSkuSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("крупный набор самоцветов не дороже за штуку мелкого, стартовый — самый выгодный и один на аккаунт", () => {
    const gems = SHOP_SKUS.filter((sku) => sku.kind === "gems").sort((a, b) => a.stars - b.stars);
    for (let index = 1; index < gems.length; index++) {
      const smaller = gems[index - 1];
      const larger = gems[index];
      if (smaller === undefined || larger === undefined) continue;
      expect((larger.contents.gems ?? 0) / larger.stars).toBeGreaterThanOrEqual((smaller.contents.gems ?? 0) / smaller.stars);
    }
    expect(SHOP_SKUS.filter((sku) => sku.once).map((sku) => sku.kind)).toEqual(["starter"]);
  });
});

describe("витрина и счёт", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("в Telegram — цены в звёздах из каталога; на площадке без способа оплаты — витрина без цен", async () => {
    const view = await ctx.shop.view(player());
    expect(view.payable).toBe(true);
    expect(view.items.map((item) => item.sku)).toEqual([...SHOP_SKUS].sort((a, b) => a.sort - b.sort).map((sku) => sku.id));
    expect(view.items.find((item) => item.sku === "gems_60")).toMatchObject({ stars: 50, chargedStars: 50, owned: false, contents: [{ resource: "gems", amount: 60 }] });
    expect(view.mode).toBe("live");

    const vk = await ctx.shop.view(player("vk", "12345"));
    expect(vk).toMatchObject({ payable: false });
    expect(vk.items.every((item) => item.stars === null && item.chargedStars === null)).toBe(true);
  });

  it("в тестовом режиме витрина говорит об этом и показывает, что спишется звезда, — как потом в счёте", async () => {
    const test = setup(config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }));
    const view = await test.shop.view(player());
    expect(view.mode).toBe("test");
    expect(view.items.find((item) => item.sku === "gems_330")).toMatchObject({ stars: 250, chargedStars: 1 });
    expect(await test.shop.order(player(), "gems_330")).toMatchObject({ priceStars: 250, chargedStars: 1, mode: "test" });
  });

  it("счёт — по цене каталога; неизвестный товар — 404, площадка без оплаты и вход разработчика — отказ", async () => {
    const me = player();
    const invoice = await ctx.shop.order(me, "gems_330");
    expect(invoice).toMatchObject({ sku: "gems_330", status: "pending", priceStars: 250, chargedStars: 250, mode: "live" });
    expect(ctx.api.sent.at(-1)).toMatchObject({ payload: invoice.purchaseId, stars: 250, title: "330 самоцветов" });

    expect(await codeOf(ctx.shop.order(me, "chest_legendary"))).toBe("shop_sku_not_found");
    expect(await codeOf(ctx.shop.order(player("vk", "12345"), "gems_60"))).toBe("payments_unsupported");
    expect(await codeOf(ctx.shop.order(player("telegram", "dev-1"), "gems_60"))).toBe("payments_unsupported");
  });

  it("стартовый набор — один: второй счёт ложится на ту же покупку, после оплаты счёта нет, витрина помечает купленным", async () => {
    const me = player();
    const first = await ctx.shop.order(me, "starter");
    const second = await ctx.shop.order(me, "starter");
    expect(second.purchaseId).toBe(first.purchaseId);

    await pay(ctx, first.purchaseId, me.platformUserId);
    expect(await ctx.shop.order(me, "starter")).toMatchObject({ purchaseId: first.purchaseId, status: "paid", invoiceUrl: null });
    expect((await ctx.shop.view(me)).items.find((item) => item.sku === "starter")?.owned).toBe(true);
    // Другому игроку стартовый набор по-прежнему доступен.
    expect((await ctx.shop.order(player("telegram", "555000333"), "starter")).status).toBe("pending");
  });

  it("выключенная оплата не выставляет счёт", async () => {
    const off = setup(config({ PAYMENTS_ENABLED: "false" }));
    expect(await codeOf(off.shop.order(player(), "gems_60"))).toBe("endpoint_disabled");
  });
});

describe("акции — скидка от настоящей цены", () => {
  const HOUR = 3_600_000;
  const at = new Date(NOW);

  it("идущая акция: цена со скидкой, зачёркнутая — цена каталога, ярлык — фактическая скидка; до и после срока — полная цена", async () => {
    const ctx = setup();
    ctx.promoRows.seed({ sku: "gems_330", percent: 30, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + 2 * HOUR), title: "Неделя самоцветов" });
    const item = (await ctx.shop.view(player(), at)).items.find((candidate) => candidate.sku === "gems_330");
    expect(item).toMatchObject({ stars: 175, fullStars: 250, chargedStars: 175, promo: { percent: 30, endsAt: new Date(NOW + 2 * HOUR), title: "Неделя самоцветов" } });
    // Товары без акции — как были.
    expect((await ctx.shop.view(player(), at)).items.find((candidate) => candidate.sku === "gems_60")).toMatchObject({ stars: 50, fullStars: null, promo: null });

    for (const moment of [new Date(NOW - 2 * HOUR), new Date(NOW + 2 * HOUR)]) {
      const fresh = setup();
      fresh.promoRows.seed({ sku: "gems_330", percent: 30, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + 2 * HOUR) });
      expect((await fresh.shop.view(player(), moment)).items.find((candidate) => candidate.sku === "gems_330"), moment.toISOString()).toMatchObject({ stars: 250, fullStars: null, promo: null });
    }
  });

  it("цена вниз до целой звезды, ярлык не обещает больше, чем списали; снятая акция цену не трогает", async () => {
    const ctx = setup();
    // 50 × 0,67 = 33,5 → 33 звезды: фактическая скидка 34%, ярлык — 34, а не 33.
    ctx.promoRows.seed({ sku: "gems_60", percent: 33, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + HOUR) });
    ctx.promoRows.seed({ sku: "gems_700", percent: 40, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + HOUR), cancelledAt: new Date(NOW - 1), cancelledBy: randomUUID() });
    const view = await ctx.shop.view(player(), at);
    expect(view.items.find((item) => item.sku === "gems_60")).toMatchObject({ stars: 33, fullStars: 50, promo: { percent: 34 } });
    expect(view.items.find((item) => item.sku === "gems_700")).toMatchObject({ fullStars: null, promo: null });
  });

  it("счёт — по цене акции в момент заказа, и тестовый режим по-прежнему списывает звезду", async () => {
    const ctx = setup();
    ctx.promoRows.seed({ sku: "gems_330", percent: 20, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + HOUR) });
    expect(await ctx.shop.order(player(), "gems_330", at)).toMatchObject({ priceStars: 200, chargedStars: 200 });
    expect(ctx.api.sent.at(-1)).toMatchObject({ stars: 200 });

    const test = setup(config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }));
    test.promoRows.seed({ sku: "gems_330", percent: 20, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + HOUR) });
    expect(await test.shop.order(player(), "gems_330", at)).toMatchObject({ priceStars: 200, chargedStars: 1, mode: "test" });
  });

  it("разовый товар: неоплаченный счёт, выставленный до акции, при повторе берёт цену акции", async () => {
    const ctx = setup();
    const me = player();
    const before = await ctx.shop.order(me, "starter", new Date(NOW - 2 * HOUR));
    expect(before.priceStars).toBe(50);
    ctx.promoRows.seed({ sku: "starter", percent: 50, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + HOUR) });
    expect(await ctx.shop.order(me, "starter", at)).toMatchObject({ purchaseId: before.purchaseId, priceStars: 25 });
  });

  it("«лучшая цена» и подбор считаются от цены, которую игрок заплатит сейчас", async () => {
    const ctx = setup();
    const base = await ctx.shop.view(player(), at);
    const best = base.items.find((item) => item.badge === "best")?.sku;
    const cheapest = base.items.filter((item) => item.kind === "gems" && item.sku !== best).at(0)?.sku;
    if (best === undefined || cheapest === undefined) throw new Error("в каталоге нет наборов самоцветов");
    // Новая витрина: идущие акции у сервиса в памяти полминуты.
    const later = setup();
    later.promoRows.seed({ sku: cheapest, percent: 80, startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW + HOUR) });
    const promoted = await later.shop.view(player(), at);
    expect(promoted.items.find((item) => item.badge === "best")?.sku).toBe(cheapest);
  });
});

describe("подача товара — только правда", () => {
  const price = (sku: { stars: number }) => sku.stars;

  it("выгода набора самоцветов — против самого дорогого за самоцвет, вниз до целого; лучшая цена — у самого выгодного", () => {
    const value = gemValuePct(SHOP_SKUS, price);
    // 60 за 50, 330 за 250, 700 за 500: 1,2 / 1,32 / 1,4 самоцвета за звезду
    expect(Object.fromEntries(value)).toEqual({ gems_330: 10, gems_700: 16 });
    const badges = badgesOf(SHOP_SKUS, price);
    expect(badges.get("gems_700")).toBe("best");
    expect(badges.get("gems_330")).toBe("hit");
    expect(badges.has("gems_60")).toBe(false);
  });

  it("площадка без цены — ни выгоды, ни лучшей цены: обещать нечего", () => {
    expect(gemValuePct(SHOP_SKUS, () => null).size).toBe(0);
    expect([...badgesOf(SHOP_SKUS, () => null).values()]).toEqual(["hit"]);
  });

  it("первым — под игрока: новичку стартовый, носящему снаряжение — набор кузнеца, остальным — самоцветы по лучшей цене", () => {
    expect(recommendedSku(SHOP_SKUS, price, { owned: new Set(), equipped: 0 })).toBe("starter");
    expect(recommendedSku(SHOP_SKUS, price, { owned: new Set(["starter"]), equipped: 2 })).toBe("upgrade_kit");
    expect(recommendedSku(SHOP_SKUS, price, { owned: new Set(["starter"]), equipped: 0 })).toBe("gems_700");
    expect(recommendedSku(SHOP_SKUS, () => null, { owned: new Set(), equipped: 0 })).toBeNull();
  });

  it("витрина несёт бейджи, выгоду, рекомендацию и ссылку Tribute — только в Telegram и только заданную", async () => {
    const ctx = setup();
    let view = await ctx.shop.view(player());
    expect(view.items.find((item) => item.sku === "gems_700")).toMatchObject({ badge: "best", valuePct: 16 });
    expect(view.items.find((item) => item.sku === "gems_60")).toMatchObject({ badge: null, valuePct: null });
    expect(view).toMatchObject({ recommended: "starter", tribute: null });

    ctx.context.tribute = "https://t.me/tribute/app?startapp=stars";
    ctx.context.equipped = 3;
    view = await ctx.shop.view(player());
    expect(view.tribute).toBe("https://t.me/tribute/app?startapp=stars");
    expect((await ctx.shop.view(player("vk", "12345"))).tribute).toBeNull();
  });
});

describe("выдача оплаченного", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("оплата ложится на счёт составом товара, ключом покупки и с причиной «покупка»; покупка помечена выданной", async () => {
    const me = player();
    const invoice = await ctx.shop.order(me, "starter");
    await pay(ctx, invoice.purchaseId, me.platformUserId);

    const starter = skuById("starter");
    if (starter === undefined) throw new Error("нет стартового набора");
    expect(ctx.wallet.grants).toEqual(
      contentsOf(starter).map(({ resource, amount }) => ({
        accountId: me.accountId,
        resource,
        amount,
        reason: "purchase",
        source: "shop:starter",
        idempotencyKey: `purchase:${invoice.purchaseId}:${resource}`,
      })),
    );
    expect((await ctx.purchases.byId(invoice.purchaseId))?.fulfilledAt).not.toBeNull();
  });

  it("упала выдача — повтор задания выдаёт однажды; повтор обновления площадки второй раз не выдаёт", async () => {
    const me = player();
    const invoice = await ctx.shop.order(me, "gems_60");
    ctx.wallet.failNext = true;
    await expect(pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1")).rejects.toThrow(/кошелёк недоступен/);
    expect((await ctx.purchases.byId(invoice.purchaseId))?.status).toBe("paid");

    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1");
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1");
    expect(ctx.wallet.grants).toHaveLength(1);
    expect(ctx.wallet.grants[0]).toMatchObject({ resource: "gems", amount: 60 });
  });

  it("вторая оплата того же разового товара — возврат, а не второй набор", async () => {
    const me = player();
    const invoice = await ctx.shop.order(me, "starter");
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-a");
    const granted = ctx.wallet.grants.length;
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-b");
    expect(ctx.wallet.grants).toHaveLength(granted);
    expect(ctx.api.refunded).toContainEqual({ userId: Number(me.platformUserId), chargeId: "charge-b" });
  });

  it("тестовая оплата: звезда возвращается, а набор выдаётся — чтобы проверить выдачу целиком", async () => {
    const test = setup(config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }));
    const me = player();
    const invoice = await test.shop.order(me, "gems_60");
    expect(invoice).toMatchObject({ mode: "test", chargedStars: 1, priceStars: 50 });
    expect(test.api.sent.at(-1)?.title).toBe("60 самоцветов — тест");
    await pay(test, invoice.purchaseId, me.platformUserId, "charge-test");
    expect(test.wallet.grants).toHaveLength(1);
    expect(test.api.refunded).toContainEqual({ userId: Number(me.platformUserId), chargeId: "charge-test" });
  });
});

describe("магазин по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401; товар — по схеме, цены в теле нет; витрина и счёт — 200", async () => {
    const ctx = setup();
    @Module({
      controllers: [ShopController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ShopService, useValue: ctx.shop },
        // витрина снаряжения — свой тест (showcase.test.ts)
        { provide: ShowcaseService, useValue: {} },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: randomUUID(), platform: "telegram", platformUserId: "555000444" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, NOW + 1e12);
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/shop" })).statusCode).toBe(401);
    const view = await app.inject({ method: "GET", url: "/api/v1/shop", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { payable: boolean } }>().data.payable).toBe(true);

    for (const payload of [{}, { sku: "GEMS" }, { sku: "gems_60", stars: 1 }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/shop/orders", headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const missing = await app.inject({ method: "POST", url: "/api/v1/shop/orders", headers, payload: { sku: "chest_epic" } });
    expect(missing.statusCode).toBe(404);
    const order = await app.inject({ method: "POST", url: "/api/v1/shop/orders", headers, payload: { sku: "gems_60" } });
    expect(order.statusCode).toBe(200);
    expect(order.json<{ data: { status: string; priceStars: number } }>().data).toMatchObject({ status: "pending", priceStars: 50 });
  });
});
