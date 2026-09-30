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
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { SubscriptionRenewal } from "../src/modules/payments/subscription-renewal.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { TITLE_MAX } from "../src/modules/shop/shop-catalog.js";
import { VIP_DAILY_GEMS, VIP_PERIOD_SEC, VIP_PLAN } from "../src/modules/vip/vip-plan.js";
import { VipController } from "../src/modules/vip/vip.controller.js";
import { VipService } from "../src/modules/vip/vip.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { gameDay, MemoryVipRepository } from "./helpers/memory-vip.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * VIP (docs/35-stage4-plan.md §3.6, Р20, Р26, Р44; WP10): оплата — период с
 * момента оплаты, продление — следующий период с конца прежнего; отмена не
 * отнимает оплаченного; вернуть продление кнопкой можно только отменённое
 * нами; самоцветы дня — раз в сутки и только пока VIP идёт.
 */

const DAY_MS = 86_400_000;

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

function player(platform: AccountRef["platform"] = "telegram"): AccountRef {
  return { accountId: randomUUID(), platform, platformUserId: String(555_000_000 + Math.floor(Math.random() * 1_000_000)) };
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

function setup(settings = config()) {
  const purchases = new MemoryPurchasesRepository();
  const api = new FakeStarsApi();
  const providers = starsProviders(api);
  const hooks = new PaymentsHooks();
  const fulfillment = new PurchaseFulfillment();
  const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
  const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), hooks);
  const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers), new RunsHooks(), providers, fulfillment, purchases);
  const repository = new MemoryVipRepository();
  const wallet = new FakeWallet();
  const vip = new VipService(repository, payments, fulfillment, hooks, new SubscriptionRenewal(purchases, providers), wallet as unknown as WalletService);
  vip.onModuleInit();
  return { purchases, api, confirmation, queue, repository, wallet, vip };
}

type Ctx = ReturnType<typeof setup>;

/** Площадка подтвердила оплату — задание очереди, как его выполнил бы воркер. */
async function pay(ctx: Ctx, account: AccountRef, purchaseId: string, chargeId: string): Promise<void> {
  const row = await ctx.purchases.byId(purchaseId);
  if (row === null) throw new Error("нет покупки");
  ctx.purchases.owners.set(row.accountId, account.platformUserId);
  await ctx.queue.process({
    data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: purchaseId, payerId: account.platformUserId, currency: "XTR", totalAmount: row.chargedStars } },
  });
}

/** Оформить VIP и оплатить первый период. */
async function subscribe(ctx: Ctx, account: AccountRef, chargeId = "charge-1"): Promise<string> {
  const invoice = await ctx.vip.order(account);
  await pay(ctx, account, invoice.purchaseId, chargeId);
  return invoice.purchaseId;
}

describe("план VIP", () => {
  it("название влезает в окно оплаты, цена — ручная в звёздах, самоцветы дня — под суточным потолком кошелька", async () => {
    expect(VIP_PLAN.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(VIP_PERIOD_SEC).toBe(30 * 24 * 3600);
    expect(VIP_DAILY_GEMS).toBeLessThanOrEqual(WALLET_DAILY_CAPS.subscription_daily.gems ?? 0);
    expect((await setup().vip.view(player())).stars).toBe(VIP_PLAN.stars);
  });

  it("состояние VIP называет товар, режим оплаты и сколько спишется: в тестовом режиме — звезда", async () => {
    expect(await setup().vip.view(player())).toMatchObject({ sku: VIP_PLAN.sku, mode: "live", stars: VIP_PLAN.stars, chargedStars: VIP_PLAN.stars });
    expect(await setup(config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" })).vip.view(player())).toMatchObject({ mode: "test", stars: VIP_PLAN.stars, chargedStars: 1 });
  });

  it("на площадке без способа оплаты VIP виден без цены, а счёт не выставляется", async () => {
    const ctx = setup();
    const account = player("max");
    expect(await ctx.vip.view(account)).toMatchObject({ stars: null, chargedStars: null, active: false, canOrder: true });
    expect(await codeOf(ctx.vip.order(account))).toBe("payments_unsupported");
  });
});

describe("оформление и продление VIP", () => {
  let ctx: Ctx;
  let account: AccountRef;

  beforeEach(() => {
    ctx = setup();
    account = player();
  });

  it("счёт — подписка на 30 суток; до оплаты VIP нет, оплата — период с её момента", async () => {
    const invoice = await ctx.vip.order(account);
    expect(ctx.api.sent[0]).toMatchObject({ stars: VIP_PLAN.stars, subscriptionPeriodSec: VIP_PERIOD_SEC, title: VIP_PLAN.title });
    expect(await ctx.vip.view(account)).toMatchObject({ active: false, until: null, renewal: null, canOrder: true });

    const before = Date.now();
    await pay(ctx, account, invoice.purchaseId, "charge-1");
    const view = await ctx.vip.view(account);
    expect(view).toMatchObject({ active: true, renewal: "on", canOrder: false, canResume: false });
    expect(view.until?.getTime()).toBeGreaterThanOrEqual(before + VIP_PERIOD_SEC * 1000);
    expect(await ctx.purchases.byId(invoice.purchaseId)).toMatchObject({ fulfilledAt: expect.any(Date) });
  });

  it("идущий и продлеваемый VIP второй раз не оформить — вторая подписка списывала бы деньги дважды", async () => {
    await subscribe(ctx, account);
    expect(await codeOf(ctx.vip.order(account))).toBe("vip_active");
  });

  it("продление — следующий период с конца прежнего, а не с оплаты; повтор выдачи не продлевает", async () => {
    const first = await subscribe(ctx, account);
    const until = (await ctx.vip.view(account)).until?.getTime() ?? 0;

    await pay(ctx, account, first, "charge-2");
    await pay(ctx, account, first, "charge-2");

    expect((await ctx.vip.view(account)).until?.getTime()).toBe(until + VIP_PERIOD_SEC * 1000);
    expect(ctx.repository.periods.size).toBe(2);
  });

  it("отмена нашей кнопкой: Telegram получает её по первой оплате, VIP идёт до конца периода, продление можно вернуть", async () => {
    await subscribe(ctx, account);

    const cancelled = await ctx.vip.cancel(account);
    expect(ctx.api.renewals).toEqual([{ userId: Number(account.platformUserId), chargeId: "charge-1", canceled: true }]);
    expect(cancelled).toMatchObject({ active: true, renewal: "cancelled", canResume: true, canOrder: true });

    const resumed = await ctx.vip.resume(account);
    expect(ctx.api.renewals.at(-1)).toEqual({ userId: Number(account.platformUserId), chargeId: "charge-1", canceled: false });
    expect(resumed).toMatchObject({ active: true, renewal: "on", canResume: false, canOrder: false });
  });

  it("отменил игрок у себя — вернуть кнопкой нельзя, и наша отмена его не перебивает", async () => {
    const first = await subscribe(ctx, account);
    await ctx.confirmation.subscriptionChanged({ platform: "telegram", payload: first, payerId: account.platformUserId, state: "cancelled" });

    expect(await ctx.vip.view(account)).toMatchObject({ active: true, renewal: "cancelled", canResume: false });
    expect(await codeOf(ctx.vip.resume(account))).toBe("vip_resume_unavailable");
    await ctx.vip.cancel(account);
    expect(ctx.api.renewals).toEqual([]);
    expect(ctx.repository.subscriptions.get(first)).toMatchObject({ renewal: "cancelled", cancelledBy: "player" });
  });

  it("Telegram не отменил — продления там уже нет: записываем отмену игрока, а не нашу", async () => {
    const first = await subscribe(ctx, account);
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 400, "Bad Request: SUBSCRIPTION_CANCELED", null);

    expect(await ctx.vip.cancel(account)).toMatchObject({ renewal: "cancelled", canResume: false });
    expect(ctx.repository.subscriptions.get(first)).toMatchObject({ cancelledBy: "player" });
  });

  it("списание не прошло — продление `failed`, оформить заново можно; прошло позже — снова `on`", async () => {
    const first = await subscribe(ctx, account);
    await ctx.confirmation.subscriptionChanged({ platform: "telegram", payload: first, payerId: account.platformUserId, state: "failed" });
    expect(await ctx.vip.view(account)).toMatchObject({ renewal: "failed", canOrder: true });

    await new Promise((resolve) => setTimeout(resolve, 2));
    await pay(ctx, account, first, "charge-2");
    expect(await ctx.vip.view(account)).toMatchObject({ renewal: "on", canOrder: false });
  });

  it("вернул продление у себя — снова `on`; о подписке, которой ещё нет, — только в лог", async () => {
    const first = await subscribe(ctx, account);
    await ctx.vip.cancel(account);
    await ctx.confirmation.subscriptionChanged({ platform: "telegram", payload: first, payerId: account.platformUserId, state: "active" });
    expect(await ctx.vip.view(account)).toMatchObject({ renewal: "on" });

    const pending = await ctx.vip.order(player());
    ctx.purchases.owners.set((await ctx.purchases.byId(pending.purchaseId))?.accountId ?? "", "777");
    await expect(ctx.confirmation.subscriptionChanged({ platform: "telegram", payload: pending.purchaseId, payerId: "777", state: "cancelled" })).resolves.toBeUndefined();
    expect(ctx.repository.subscriptions.has(pending.purchaseId)).toBe(false);
  });

  it("отменённый VIP после конца периода — не идёт, оформить можно заново", async () => {
    await subscribe(ctx, account);
    await ctx.vip.cancel(account);
    const later = new Date(Date.now() + 31 * DAY_MS);
    expect(await ctx.vip.view(account, later)).toMatchObject({ active: false, renewal: "cancelled", canResume: false, canOrder: true });
    expect(await codeOf(ctx.vip.resume(account, later))).toBe("vip_resume_unavailable");
  });
});

describe("самоцветы VIP", () => {
  let ctx: Ctx;
  let account: AccountRef;

  beforeEach(() => {
    ctx = setup();
    account = player();
  });

  it("без VIP не выдаются", async () => {
    expect(await codeOf(ctx.vip.claimDaily(account))).toBe("vip_inactive");
    expect(ctx.wallet.grants).toEqual([]);
  });

  it("раз в игровые сутки, ключом суток, по причине `subscription_daily`", async () => {
    await subscribe(ctx, account);
    const at = new Date();

    expect(await ctx.vip.claimDaily(account, at)).toMatchObject({ claimed: true, gems: VIP_DAILY_GEMS, view: { daily: { claimed: true } } });
    expect(await ctx.vip.claimDaily(account, at)).toMatchObject({ claimed: false, gems: 0 });
    expect(ctx.wallet.grants).toEqual([
      { accountId: account.accountId, resource: "gems", amount: VIP_DAILY_GEMS, reason: "subscription_daily", source: "vip_daily", idempotencyKey: `vip_daily:${account.accountId}:${gameDay(at)}`, at },
    ]);

    const tomorrow = new Date(at.getTime() + DAY_MS);
    expect(await ctx.vip.claimDaily(account, tomorrow)).toMatchObject({ claimed: true });
    expect(ctx.wallet.grants).toHaveLength(2);
  });

  it("кошелёк упал — сутки не отмечены, повтор выдаёт", async () => {
    await subscribe(ctx, account);
    ctx.wallet.failNext = true;
    await expect(ctx.vip.claimDaily(account)).rejects.toThrow("кошелёк недоступен");
    expect(await ctx.vip.claimDaily(account)).toMatchObject({ claimed: true, gems: VIP_DAILY_GEMS });
  });
});

describe("VIP по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401; состояние и счёт — 200; самоцветы без VIP — 409", async () => {
    const ctx = setup();
    @Module({
      controllers: [VipController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: VipService, useValue: ctx.vip },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: randomUUID(), platform: "telegram", platformUserId: "555000444" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now() + 1e12);
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/vip" })).statusCode).toBe(401);
    const view = await app.inject({ method: "GET", url: "/api/v1/vip", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { active: boolean; stars: number } }>().data).toMatchObject({ active: false, stars: VIP_PLAN.stars });

    const order = await app.inject({ method: "POST", url: "/api/v1/vip/orders", headers });
    expect(order.statusCode).toBe(200);
    expect(order.json<{ data: { status: string; sku: string } }>().data).toMatchObject({ status: "pending", sku: VIP_PLAN.sku });

    const daily = await app.inject({ method: "POST", url: "/api/v1/vip/daily", headers });
    expect(daily.statusCode).toBe(409);
    expect(daily.json<{ error: { code: string } }>().error.code).toBe("vip_inactive");
    expect((await app.inject({ method: "POST", url: "/api/v1/vip/resume", headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/vip/cancel", headers })).statusCode).toBe(200);
  });
});
