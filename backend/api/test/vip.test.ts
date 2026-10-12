import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import type { Account, AccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { SubscriptionRenewal } from "../src/modules/payments/subscription-renewal.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { TITLE_MAX } from "../src/modules/shop/shop-catalog.js";
import { VIP_DAILY_GEMS, VIP_PERIOD_SEC, VIP_PLAN, VIP_REWARD_MUL } from "../src/modules/vip/vip-plan.js";
import { VipController } from "../src/modules/vip/vip.controller.js";
import { VipService } from "../src/modules/vip/vip.service.js";
import { WalletBonuses } from "../src/modules/wallet/wallet-bonus.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { ADMIN_REASON } from "../src/modules/wallet/wallet-types.js";
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

/** Память VIP с отзывом периода: что спросили и что ответить — задаёт тест. */
class CuttingVipRepository extends MemoryVipRepository {
  readonly cuts: { purchaseId: string; at: Date }[] = [];
  cutResult: { subscriptionId: string; removedSec: number; until: Date | null } | null = null;
  cutFailWith: Error | null = null;

  async cutPeriod(purchaseId: string, at: Date): Promise<{ subscriptionId: string; removedSec: number; until: Date | null } | null> {
    this.cuts.push({ purchaseId, at });
    if (this.cutFailWith !== null) throw this.cutFailWith;
    return this.cutResult;
  }
}

/**
 * Аккаунты для выдачи: владельца подписки находят по id, как в базе.
 * Идентификатор на площадке берётся из карты владельцев покупок — её
 * заполняет оплата в `pay`.
 */
function accountsOf(purchases: MemoryPurchasesRepository): Pick<AccountRepository, "byId"> {
  return {
    byId: async (accountId): Promise<Account | null> => {
      const platformUserId = purchases.owners.get(accountId);
      if (platformUserId === undefined) return null;
      return { accountId, platform: "telegram", platformUserId, displayName: "Стрелок", username: null, photoUrl: null, createdAt: new Date(), bannedAt: null, banReason: null, created: false };
    },
  };
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

/** `register: false` — выдачу и отзыв зарегистрирует сам Nest при старте модуля: вручную дважды реестр отзыва не примет. */
function setup(settings = config(), register = true) {
  const purchases = new MemoryPurchasesRepository();
  const api = new FakeStarsApi();
  const providers = starsProviders(api);
  const hooks = new PaymentsHooks();
  const fulfillment = new PurchaseFulfillment();
  const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
  const revocation = new PurchaseRevocation();
  const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), hooks, revocation);
  const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers), new RunsHooks(), providers, fulfillment, purchases);
  const repository = new CuttingVipRepository();
  const wallet = new FakeWallet();
  const bonuses = new WalletBonuses();
  const adPasses = new AdPasses();
  const renewal = new SubscriptionRenewal(purchases, providers);
  const accounts = accountsOf(purchases);
  const vip = new VipService(repository, payments, fulfillment, hooks, renewal, wallet as unknown as WalletService, bonuses, adPasses, accounts, revocation);
  if (register) vip.onModuleInit();
  return { purchases, api, confirmation, queue, repository, wallet, vip, bonuses, adPasses, renewal, accounts, revocation };
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

describe("вторая подписка: две оплаты проскочили одновременно (T-0025)", () => {
  let ctx: Ctx;
  let account: AccountRef;
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  /** Два счёта, выставленных до первой оплаты: каждый по отдельности законный. */
  async function twoInvoices(): Promise<[string, string]> {
    const first = await ctx.vip.order(account);
    const second = await ctx.vip.order(account);
    expect(second.purchaseId).not.toBe(first.purchaseId);
    return [first.purchaseId, second.purchaseId];
  }

  beforeEach(() => {
    ctx = setup();
    account = player();
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        const fields = JSON.parse(String(message)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("у второй подписки продление выключено на площадке и в базе, период выдан и встал за первым, первая не тронута", async () => {
    const [first, second] = await twoInvoices();
    const set = vi.spyOn(ctx.renewal, "set");

    await pay(ctx, account, first, "charge-1");
    expect(set).not.toHaveBeenCalled();
    await pay(ctx, account, second, "charge-2");

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(account, second, false);
    expect(ctx.api.renewals).toEqual([{ userId: Number(account.platformUserId), chargeId: "charge-2", canceled: true }]);
    expect(ctx.repository.subscriptions.get(second)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
    expect(ctx.repository.subscriptions.get(first)).toMatchObject({ renewal: "on", cancelledBy: null });
    // Заплатил — период остаётся: он встаёт за первым, отнимать нечего.
    const firstPeriod = ctx.repository.periods.get(first);
    expect(ctx.repository.periods.get(second)?.startsAt).toEqual(firstPeriod?.endsAt);
    expect(await ctx.purchases.byId(second)).toMatchObject({ fulfilledAt: expect.any(Date) });
    expect(await ctx.vip.view(account)).toMatchObject({ active: true, renewal: "on" });
  });

  it("случай пишется в лог уровнем error: событие vip_subscription_twice, аккаунт, оставленная и остановленная подписки", async () => {
    const [first, second] = await twoInvoices();

    await pay(ctx, account, first, "charge-1");
    await pay(ctx, account, second, "charge-2");

    const twice = logged.filter((entry) => entry.event === "vip_subscription_twice");
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ level: "error", fields: { module: "vip", accountId: account.accountId, kept: first, stopped: second } });
  });

  it("повтор выдачи второй подписки продление повторно не трогает: период уже был", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    await pay(ctx, account, second, "charge-2");
    const set = vi.spyOn(ctx.renewal, "set");
    const row = await ctx.purchases.byId(second);
    if (row === null) throw new Error("покупки нет");

    await ctx.vip.fulfill(row);

    expect(set).not.toHaveBeenCalled();
    expect(logged.filter((entry) => entry.event === "vip_subscription_twice")).toHaveLength(1);
  });

  it("новая подписка без других — продление не трогается", async () => {
    const set = vi.spyOn(ctx.renewal, "set");

    await subscribe(ctx, account);

    expect(set).not.toHaveBeenCalled();
    expect(ctx.api.renewals).toEqual([]);
    expect(logged.map((entry) => entry.event)).not.toContain("vip_subscription_twice");
  });

  it("другая подписка отменена или не списала — вторая не дубль: продлевается только одна", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    await ctx.vip.cancel(account);
    const set = vi.spyOn(ctx.renewal, "set");

    await pay(ctx, account, second, "charge-2");

    expect(set).not.toHaveBeenCalled();
    expect(ctx.repository.subscriptions.get(second)).toMatchObject({ renewal: "on" });
  });

  it("продление первой подписки при другой продлеваемой — продление не трогается", async () => {
    const first = await subscribe(ctx, account);
    // Другая подписка с включённым продлением — как после гонки, которую этот случай и ловит.
    const other = randomUUID();
    await ctx.repository.addPeriod({ purchaseId: other, subscriptionId: other, accountId: account.accountId, paidAt: new Date(), periodSec: VIP_PERIOD_SEC, at: new Date() });
    const set = vi.spyOn(ctx.renewal, "set");

    await pay(ctx, account, first, "charge-2");

    expect(set).not.toHaveBeenCalled();
    expect(ctx.repository.subscriptions.get(first)).toMatchObject({ renewal: "on" });
  });

  it("площадка не приняла выключение — fulfill не бросает, период выдан, причина в логе", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 0, "сеть недоступна", null);

    await expect(pay(ctx, account, second, "charge-2")).resolves.toBeUndefined();

    expect(ctx.repository.periods.has(second)).toBe(true);
    expect(await ctx.purchases.byId(second)).toMatchObject({ fulfilledAt: expect.any(Date) });
    expect(ctx.repository.subscriptions.get(second)).toMatchObject({ renewal: "on" });
    expect(logged).toContainEqual(expect.objectContaining({ level: "error", event: "vip_subscription_twice_stop_failed", fields: expect.objectContaining({ stopped: second }) as Record<string, unknown> }));
  });

  it("база не записала отмену — fulfill не бросает, период выдан, причина в логе", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    ctx.repository.setRenewal = async () => Promise.reject(new Error("база недоступна"));

    await expect(pay(ctx, account, second, "charge-2")).resolves.toBeUndefined();

    expect(ctx.repository.periods.has(second)).toBe(true);
    expect(logged).toContainEqual(
      expect.objectContaining({ level: "error", event: "vip_subscription_twice_stop_failed", fields: expect.objectContaining({ reason: "база недоступна" }) as Record<string, unknown> }),
    );
  });

  it("не прочиталось состояние подписок — fulfill не бросает: повтор задания период уже не повторит", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    ctx.repository.state = async () => Promise.reject(new Error("база недоступна"));

    await expect(pay(ctx, account, second, "charge-2")).resolves.toBeUndefined();

    expect(ctx.repository.periods.has(second)).toBe(true);
    expect(logged.map((entry) => entry.event)).toContain("vip_subscription_twice_stop_failed");
  });

  it("аккаунта нет — продление не трогается, fulfill не бросает, в лог error", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    vi.spyOn(ctx.accounts, "byId").mockResolvedValue(null);
    const set = vi.spyOn(ctx.renewal, "set");

    await expect(pay(ctx, account, second, "charge-2")).resolves.toBeUndefined();

    expect(set).not.toHaveBeenCalled();
    expect(ctx.repository.periods.has(second)).toBe(true);
    expect(logged).toContainEqual(expect.objectContaining({ level: "error", event: "vip_subscription_twice_stop_failed", fields: expect.objectContaining({ stopped: second }) as Record<string, unknown> }));
  });

  it("площадка ответила отказом — продления там уже нет: в базе отмена игрока, а не наша", async () => {
    const [first, second] = await twoInvoices();
    await pay(ctx, account, first, "charge-1");
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 400, "Bad Request: SUBSCRIPTION_CANCELED", null);

    await pay(ctx, account, second, "charge-2");

    expect(ctx.repository.subscriptions.get(second)).toMatchObject({ renewal: "cancelled", cancelledBy: "player" });
    expect(logged.map((entry) => entry.event)).toContain("vip_subscription_twice");
  });
});

describe("отзыв VIP при внешнем возврате звёзд (T-0023)", () => {
  let ctx: Ctx;
  let account: AccountRef;
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];
  /** Момент возврата: период в 30 суток, оплаченный сейчас, ещё идёт. */
  const AT = new Date(Date.UTC(2026, 9, 6, 9, 5, 0));

  async function paidVip(): Promise<StoredPurchase> {
    const first = await subscribe(ctx, account);
    const row = await ctx.purchases.byId(first);
    if (row === null) throw new Error("покупки нет");
    return row;
  }

  beforeEach(() => {
    ctx = setup();
    account = player();
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        const fields = JSON.parse(String(message)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("период обрезан по моменту возврата, продление выключено на площадке и в базе, строки — для лога и карточки", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 20 * 86_400, until: new Date(Date.UTC(2026, 9, 16, 12, 30)) };

    const result = await ctx.vip.revoke(row, AT);

    expect(ctx.repository.cuts).toEqual([{ purchaseId: row.purchaseId, at: AT }]);
    expect(ctx.api.renewals).toEqual([{ userId: Number(account.platformUserId), chargeId: "charge-1", canceled: true }]);
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
    expect(result.lines).toEqual(["VIP: убрано 480 ч, теперь до 2026-10-16 12:30", "продление выключено"]);
  });

  it("отзыв зовёт площадку для аккаунта из покупки, а не из чужих данных", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    const set = vi.spyOn(ctx.renewal, "set");

    await ctx.vip.revoke(row, AT);

    expect(set).toHaveBeenCalledWith(account, row.purchaseId, false);
  });

  it("продление выключается у подписки периода, а не у покупки: у оплаты продления она — первая покупка", async () => {
    const first = await paidVip();
    ctx.repository.cutResult = { subscriptionId: first.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    const renewalPurchase: StoredPurchase = { ...first, purchaseId: randomUUID(), renewalOf: first.purchaseId, telegramChargeId: "charge-2" };
    const set = vi.spyOn(ctx.renewal, "set");

    await ctx.vip.revoke(renewalPurchase, AT);

    expect(ctx.repository.cuts[0]?.purchaseId).toBe(renewalPurchase.purchaseId);
    expect(set).toHaveBeenCalledWith(account, first.purchaseId, false);
    expect(ctx.repository.subscriptions.get(first.purchaseId)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
  });

  it("VIP кончился с возвратом — строка говорит об этом, а не обещает «до»", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 30 * 86_400, until: AT };

    const result = await ctx.vip.revoke(row, AT);

    expect(result.lines).toEqual(["VIP: убрано 720 ч, VIP закончился", "продление выключено"]);
  });

  it("дробные часы пишутся с десятой: полчаса — 0.5 ч", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 1_800, until: new Date(AT.getTime() + 86_400_000) };

    const result = await ctx.vip.revoke(row, AT);

    expect(result.lines[0]).toBe("VIP: убрано 0.5 ч, теперь до 2026-10-07 09:05");
  });

  it("остаток уже использован — «период уже использован», а продление всё равно выключается", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 0, until: new Date(AT.getTime() + 86_400_000) };

    const result = await ctx.vip.revoke(row, AT);

    expect(result.lines).toEqual(["VIP: период уже использован", "продление выключено"]);
    expect(ctx.api.renewals).toHaveLength(1);
  });

  it("периода нет — «VIP: периода нет», ни площадка, ни база не тронуты", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = null;

    const result = await ctx.vip.revoke(row, AT);

    expect(result.lines).toEqual(["VIP: периода нет"]);
    expect(ctx.api.renewals).toEqual([]);
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "on" });
  });

  it("площадка отказала — продления там уже нет: отзыв идёт дальше, в базе отмена", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 400, "Bad Request: SUBSCRIPTION_CANCELED", null);

    const result = await ctx.vip.revoke(row, AT);

    expect(result.lines.at(-1)).toBe("продление выключено");
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
  });

  it("площадка недоступна — не роняет отзыв: в лог warn, в базе отмена", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 0, "сеть недоступна", null);

    await expect(ctx.vip.revoke(row, AT)).resolves.toMatchObject({ lines: expect.any(Array) as string[] });

    expect(logged).toContainEqual(expect.objectContaining({ level: "warn", event: "vip_revoke_renewal_failed", fields: expect.objectContaining({ subscriptionId: row.purchaseId }) as Record<string, unknown> }));
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
  });

  it("аккаунта нет — площадка не зовётся, отмена в базе записывается, в лог warn", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    vi.spyOn(ctx.accounts, "byId").mockResolvedValue(null);
    const set = vi.spyOn(ctx.renewal, "set");

    await ctx.vip.revoke(row, AT);

    expect(set).not.toHaveBeenCalled();
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
    expect(logged.map((entry) => entry.event)).toContain("vip_revoke_renewal_failed");
  });

  it("база не ответила на чтение аккаунта — отзыв бросает, площадка не зовётся: повтор выключит продление там", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    vi.spyOn(ctx.accounts, "byId").mockRejectedValue(new Error("база недоступна"));
    const set = vi.spyOn(ctx.renewal, "set");

    await expect(ctx.vip.revoke(row, AT)).rejects.toThrow("база недоступна");

    expect(set).not.toHaveBeenCalled();
    expect(ctx.repository.subscriptions.get(row.purchaseId)).not.toMatchObject({ renewal: "cancelled" });
  });

  it("не записалась отмена в базе — отзыв бросает: обработка возврата повторится", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 3600, until: new Date(AT.getTime() + 86_400_000) };
    ctx.repository.setRenewal = async () => Promise.reject(new Error("база недоступна"));

    await expect(ctx.vip.revoke(row, AT)).rejects.toThrow("база недоступна");
  });

  it("не обрезался период — отзыв бросает, площадка не зовётся: сначала срок, потом продление", async () => {
    const row = await paidVip();
    ctx.repository.cutFailWith = new Error("база недоступна");

    await expect(ctx.vip.revoke(row, AT)).rejects.toThrow("база недоступна");

    expect(ctx.api.renewals).toEqual([]);
  });

  it("внешний возврат целиком: реестр отдаёт покупку VIP, повтор обработки обрезает с тем же моментом", async () => {
    const row = await paidVip();
    ctx.repository.cutResult = { subscriptionId: row.purchaseId, removedSec: 20 * 86_400, until: new Date(Date.UTC(2026, 9, 16)) };

    await ctx.confirmation.refunded("charge-1", AT.getTime());
    await ctx.confirmation.refunded("charge-1", AT.getTime() + 600_000);

    expect(ctx.repository.cuts).toEqual([
      { purchaseId: row.purchaseId, at: AT },
      { purchaseId: row.purchaseId, at: AT },
    ]);
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
  });

  it("наш возврат VIP (не внешний) срок и продление не трогает", async () => {
    const row = await paidVip();
    await ctx.purchases.requestRefund(row.purchaseId, "undeliverable", AT);

    await ctx.confirmation.refunded("charge-1", AT.getTime());

    expect(ctx.repository.cuts).toEqual([]);
    expect(ctx.repository.subscriptions.get(row.purchaseId)).toMatchObject({ renewal: "on" });
  });

  it("VIP регистрирует свой отзыв в реестре сам: чужая вторая регистрация того же вида — ошибка", () => {
    expect(() => ctx.revocation.register("vip", async () => ({ lines: [] }))).toThrow("отзыв vip уже зарегистрирован");
  });
});

describe("увеличенные награды и реклама без ролика (Р44, §3.6)", () => {
  it("пока VIP идёт — надбавка награде дня, колеса, забега и заданий; другим причинам, без VIP и после конца — единица", async () => {
    const ctx = setup();
    const account = player();
    const now = new Date();
    expect(await ctx.bonuses.multiplier(account.accountId, "run_reward", now)).toBe(1);

    await subscribe(ctx, account);
    for (const reason of ["daily_reward", "wheel_reward", "run_reward", "task_reward"] as const) {
      expect(await ctx.bonuses.multiplier(account.accountId, reason, now), reason).toBe(VIP_REWARD_MUL[reason]);
    }
    for (const reason of ["friend_gift", "ad_reward", "subscription_daily", "purchase", ADMIN_REASON] as const) {
      expect(await ctx.bonuses.multiplier(account.accountId, reason, now), reason).toBe(1);
    }
    expect(await ctx.bonuses.multiplier(account.accountId, "run_reward", new Date(now.getTime() + 31 * DAY_MS))).toBe(1);
    expect(await ctx.bonuses.multiplier(player().accountId, "run_reward", now)).toBe(1);
  });

  it("реклама без ролика: пропуск модуля рекламы — пока VIP идёт, без VIP и после конца — нет", async () => {
    const ctx = setup();
    const account = player();
    const now = new Date();
    expect(await ctx.adPasses.of(account.accountId, now)).toBeNull();
    await subscribe(ctx, account);
    expect(await ctx.adPasses.of(account.accountId, now)).toBe("vip");
    expect(await ctx.adPasses.of(account.accountId, new Date(now.getTime() + 31 * DAY_MS))).toBeNull();
    expect(await ctx.adPasses.of(player().accountId, now)).toBeNull();
  });

  it("состояние VIP говорит, во сколько раз больше награды, — экран пишет это в карточке", async () => {
    expect((await setup().vip.view(player())).rewardMul).toBe(VIP_REWARD_MUL.run_reward);
  });

  it("множители — не меньше единицы и только у причин «из ничего» с суточным потолком", () => {
    for (const [reason, mul] of Object.entries(VIP_REWARD_MUL)) {
      expect(mul, reason).toBeGreaterThanOrEqual(1);
      expect(Object.keys(WALLET_DAILY_CAPS), reason).toContain(reason);
    }
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
    const ctx = setup(config(), false);
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
