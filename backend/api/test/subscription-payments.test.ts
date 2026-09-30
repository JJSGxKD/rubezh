import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PaymentConfirmation, type ConfirmedPayment } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks, type SubscriptionChange } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { SubscriptionRenewal } from "../src/modules/payments/subscription-renewal.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PaymentProviderRejectedError, PaymentProviderUnavailableError } from "../src/platforms/ports/payment-provider.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { ALLOWED_UPDATES, TelegramApiError, updateSchema } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramPaymentsHandler } from "../src/platforms/telegram/telegram-payments.handler.js";
import { STARS_SUBSCRIPTION_PERIOD_SEC, TelegramStarsProvider } from "../src/platforms/telegram/telegram-stars-provider.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * Подписка площадки в оплате (docs/35-stage4-plan.md §3.6, Р20): счёт с
 * периодом, продление — вторая оплата того же счёта, записанная своей
 * строкой, а не возвращённая как лишняя; отмена и возврат продления нашей
 * кнопкой; что игрок сделал с продлением у себя в Telegram.
 */

const NOW = Date.UTC(2026, 8, 30, 9);
const PLAYER_ID = "555000333";

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

function player(platformUserId = PLAYER_ID): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId };
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

const ORDER = { product: "vip", sku: "vip_month", priceStars: 200, once: false, subscriptionPeriodSec: STARS_SUBSCRIPTION_PERIOD_SEC, text: { title: "VIP на 30 дней", description: "…" } } as const;

function setup(settings = config()) {
  const purchases = new MemoryPurchasesRepository();
  const api = new FakeStarsApi();
  const providers = starsProviders(api);
  const hooks = new PaymentsHooks();
  const fulfillment = new PurchaseFulfillment();
  const fulfilled: StoredPurchase[] = [];
  fulfillment.register("vip", async (purchase) => void fulfilled.push(purchase));
  const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
  const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), hooks);
  const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers), new RunsHooks(), providers, fulfillment, purchases);
  return { purchases, api, providers, hooks, payments, confirmation, queue, fulfilled };
}

/** Площадка подтвердила оплату — задание очереди, как его выполнил бы воркер. */
async function pay(ctx: ReturnType<typeof setup>, purchaseId: string, chargeId: string): Promise<void> {
  const row = await ctx.purchases.byId(purchaseId);
  if (row === null) throw new Error("нет покупки");
  // В базе получатель возврата — из аккаунта покупки.
  ctx.purchases.owners.set(row.accountId, PLAYER_ID);
  const payment: ConfirmedPayment = { platform: "telegram", chargeId, payload: purchaseId, payerId: PLAYER_ID, currency: "XTR", totalAmount: row.chargedStars };
  await ctx.queue.process({ data: { kind: "confirm", payment } });
}

describe("подписка Stars в адаптере Telegram", () => {
  it("счёт подписки несёт период: Telegram спишет его сам через 30 суток", async () => {
    const api = new FakeStarsApi();
    const provider = new TelegramStarsProvider(api, true);
    expect(provider.subscriptionPeriodSec).toBe(2_592_000);
    await provider.createInvoice({ title: "VIP", description: "…", payload: "p-1", label: "VIP", amount: 200, subscriptionPeriodSec: 2_592_000 });
    expect(api.sent).toEqual([{ title: "VIP", description: "…", payload: "p-1", label: "VIP", stars: 200, subscriptionPeriodSec: 2_592_000 }]);
  });

  it("отмена продления — `canceled: true`, возврат — `false`; `400` — окончательный отказ, сбой сети — временный", async () => {
    const api = new FakeStarsApi();
    const provider = new TelegramStarsProvider(api, true);
    await provider.setSubscriptionRenewal("555", "charge-1", false);
    await provider.setSubscriptionRenewal("555", "charge-1", true);
    expect(api.renewals).toEqual([
      { userId: 555, chargeId: "charge-1", canceled: true },
      { userId: 555, chargeId: "charge-1", canceled: false },
    ]);

    api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 400, "Bad Request: SUBSCRIPTION_NOT_FOUND", null);
    await expect(provider.setSubscriptionRenewal("555", "charge-1", true)).rejects.toBeInstanceOf(PaymentProviderRejectedError);
    api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 0, "сеть недоступна", null);
    await expect(provider.setSubscriptionRenewal("555", "charge-1", true)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });
});

describe("счёт на подписку", () => {
  it("уходит в Telegram с периодом, строка покупки — VIP без забега", async () => {
    const ctx = setup();
    const invoice = await ctx.payments.shopInvoice(player(), ORDER, NOW);
    expect(invoice).toMatchObject({ status: "pending", sku: "vip_month", priceStars: 200, chargedStars: 200 });
    expect(ctx.api.sent[0]).toMatchObject({ stars: 200, subscriptionPeriodSec: 2_592_000, payload: invoice.purchaseId });
    expect(await ctx.purchases.byId(invoice.purchaseId)).toMatchObject({ product: "vip", runId: null, renewalOf: null });
  });

  it("период, которого площадка не умеет, не продаётся: игрок заплатил бы не за то, что видел", async () => {
    const ctx = setup();
    expect(await codeOf(ctx.payments.shopInvoice(player(), { ...ORDER, subscriptionPeriodSec: 7 * 24 * 3600 }, NOW))).toBe("payments_unsupported");
    expect(ctx.api.sent).toEqual([]);
  });

  it("тестовая оплата подписки — одна звезда в период и честная пометка в окне", async () => {
    const ctx = setup(config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }));
    const invoice = await ctx.payments.shopInvoice(player(), ORDER, NOW);
    expect(invoice).toMatchObject({ mode: "test", chargedStars: 1 });
    expect(ctx.api.sent[0]).toMatchObject({ stars: 1, subscriptionPeriodSec: 2_592_000, title: "VIP на 30 дней — тест" });
  });
});

describe("продление подписки", () => {
  let ctx: ReturnType<typeof setup>;
  let first: string;

  beforeEach(async () => {
    ctx = setup();
    first = (await ctx.payments.shopInvoice(player(), ORDER, NOW)).purchaseId;
    await pay(ctx, first, "charge-1");
  });

  it("вторая оплата того же счёта — продление своей строкой, выдаётся и не возвращается", async () => {
    await pay(ctx, first, "charge-2");

    const renewal = [...ctx.purchases.rows.values()].find((row) => row.renewalOf === first);
    expect(renewal).toMatchObject({ product: "vip", sku: "vip_month", status: "paid", telegramChargeId: "charge-2", priceStars: 200, mode: "live" });
    expect(ctx.fulfilled.map((row) => row.telegramChargeId)).toEqual(["charge-1", "charge-2"]);
    expect(ctx.api.refunded).toEqual([]);
    expect(await ctx.purchases.byId(first)).toMatchObject({ telegramChargeId: "charge-1", renewalOf: null });
  });

  it("повтор обновления продления ничего не удваивает", async () => {
    await pay(ctx, first, "charge-2");
    await pay(ctx, first, "charge-2");

    expect([...ctx.purchases.rows.values()].filter((row) => row.renewalOf === first)).toHaveLength(1);
    expect(ctx.fulfilled).toHaveLength(2);
  });

  it("вторая оплата не подписки по-прежнему лишняя — её возвращают", async () => {
    const shop = await ctx.payments.shopInvoice(player(), { ...ORDER, product: "shop_item", sku: "gems_60", priceStars: 50, subscriptionPeriodSec: undefined }, NOW);
    await pay(ctx, shop.purchaseId, "charge-a");
    await pay(ctx, shop.purchaseId, "charge-b");

    expect(ctx.api.refunded).toEqual([{ userId: Number(PLAYER_ID), chargeId: "charge-b" }]);
    expect([...ctx.purchases.rows.values()].some((row) => row.renewalOf === shop.purchaseId)).toBe(false);
  });

  it("тестовая подписка: каждое продление — одна звезда, и она возвращается", async () => {
    const test = setup(config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }));
    const id = (await test.payments.shopInvoice(player(), ORDER, NOW)).purchaseId;
    await pay(test, id, "charge-1");
    await pay(test, id, "charge-2");

    expect(test.api.refunded.map((refund) => refund.chargeId)).toEqual(["charge-1", "charge-2"]);
    expect(test.fulfilled).toHaveLength(2);
  });
});

describe("продление в Telegram", () => {
  let ctx: ReturnType<typeof setup>;
  let first: string;
  let changes: SubscriptionChange[];

  beforeEach(async () => {
    ctx = setup();
    changes = [];
    ctx.hooks.onSubscriptionChanged("test", async (change) => void changes.push(change));
    first = (await ctx.payments.shopInvoice(player(), ORDER, NOW)).purchaseId;
    await pay(ctx, first, "charge-1");
  });

  it("игрок отменил продление у себя — слушатель узнаёт, какая подписка и что с ней", async () => {
    await ctx.confirmation.subscriptionChanged({ platform: "telegram", payload: first, payerId: PLAYER_ID, state: "cancelled" }, NOW);
    expect(changes).toMatchObject([{ subscription: { purchaseId: first, product: "vip" }, state: "cancelled", at: new Date(NOW) }]);
  });

  it("чужая, неизвестная или не подписка — в лог, а не слушателю", async () => {
    const shop = await ctx.payments.shopInvoice(player(), { ...ORDER, product: "shop_item", sku: "gems_60", subscriptionPeriodSec: undefined }, NOW);
    ctx.purchases.owners.set((await ctx.purchases.byId(shop.purchaseId))?.accountId ?? "", PLAYER_ID);

    for (const update of [
      { payload: first, payerId: "42" },
      { payload: randomUUID(), payerId: PLAYER_ID },
      { payload: "не-uuid", payerId: PLAYER_ID },
      { payload: shop.purchaseId, payerId: PLAYER_ID },
    ]) {
      await ctx.confirmation.subscriptionChanged({ platform: "telegram", state: "cancelled", ...update }, NOW);
    }
    expect(changes).toEqual([]);
  });

  it("бот читает обновления подписки и отдаёт их оплате; незнакомое состояние не роняет чтение", async () => {
    expect(ALLOWED_UPDATES).toContain("subscription");
    const seen: unknown[] = [];
    const confirmation = { subscriptionChanged: async (update: unknown) => void seen.push(update) } as unknown as PaymentConfirmation;
    const router = new BotRouter();
    new TelegramPaymentsHandler(router, confirmation, { enabled: true } as unknown as PaymentsQueue).onModuleInit();
    const update = (state: string) => updateSchema.parse({ update_id: 1, subscription: { user: { id: Number(PLAYER_ID), is_bot: false }, invoice_payload: first, state } });

    await router.dispatch(update("canceled"));
    await router.dispatch(update("failed"));
    await router.dispatch(update("toString"));
    await router.dispatch(update("paused"));

    expect(seen).toEqual([
      { platform: "telegram", payload: first, payerId: PLAYER_ID, state: "cancelled" },
      { platform: "telegram", payload: first, payerId: PLAYER_ID, state: "failed" },
    ]);
  });
});

describe("продление нашей кнопкой", () => {
  let ctx: ReturnType<typeof setup>;
  let account: AccountRef;
  let first: string;
  let renewal: SubscriptionRenewal;

  beforeEach(async () => {
    ctx = setup();
    account = player();
    first = (await ctx.payments.shopInvoice(account, ORDER, NOW)).purchaseId;
    await pay(ctx, first, "charge-1");
    renewal = new SubscriptionRenewal(ctx.purchases, ctx.providers);
  });

  it("отмена и возврат идут в Telegram по первой оплате подписки", async () => {
    expect(await renewal.set(account, first, false)).toBe("done");
    expect(await renewal.set(account, first, true)).toBe("done");
    expect(ctx.api.renewals).toEqual([
      { userId: Number(PLAYER_ID), chargeId: "charge-1", canceled: true },
      { userId: Number(PLAYER_ID), chargeId: "charge-1", canceled: false },
    ]);
  });

  it("отменённое игроком Telegram вернуть не даёт — это ответ, а не ошибка; сбой сети — «попробуйте ещё раз»", async () => {
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 400, "Bad Request: SUBSCRIPTION_CANCELED_BY_USER", null);
    expect(await renewal.set(account, first, true)).toBe("rejected");
    ctx.api.renewalFailWith = new TelegramApiError("editUserStarSubscription", 0, "сеть недоступна", null);
    expect(await codeOf(renewal.set(account, first, false))).toBe("payments_unavailable");
  });

  it("чужая, неоплаченная, продление вместо первой и не подписка — «не найдено», а Telegram не трогаем", async () => {
    const pendingVip = (await ctx.payments.shopInvoice(account, ORDER, NOW)).purchaseId;
    await pay(ctx, first, "charge-2");
    const renewalRow = [...ctx.purchases.rows.values()].find((row) => row.renewalOf === first)?.purchaseId ?? "";
    const shop = await ctx.payments.shopInvoice(account, { ...ORDER, product: "shop_item", sku: "gems_60", subscriptionPeriodSec: undefined }, NOW);
    await pay(ctx, shop.purchaseId, "charge-s");

    expect(await codeOf(renewal.set(player(), first, false))).toBe("purchase_not_found");
    expect(await codeOf(renewal.set(account, pendingVip, false))).toBe("purchase_not_found");
    expect(await codeOf(renewal.set(account, renewalRow, false))).toBe("purchase_not_found");
    expect(await codeOf(renewal.set(account, shop.purchaseId, false))).toBe("purchase_not_found");
    expect(await codeOf(renewal.set(account, randomUUID(), false))).toBe("purchase_not_found");
    expect(ctx.api.renewals).toEqual([]);
  });
});
