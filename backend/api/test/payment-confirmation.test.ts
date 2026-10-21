import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { answerOf, decideCheckout, type PreCheckout } from "../src/modules/payments/checkout-answer.js";
import { PaymentConfirmation, type ConfirmedPayment } from "../src/modules/payments/payment-confirmation.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks, type ExternalRefund } from "../src/modules/payments/payments-hooks.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import type { RestrictionRow } from "../src/modules/restrictions/restrictions.repository.js";
import { ALLOWED_UPDATES, TelegramApiError, updateSchema, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramPaymentsHandler } from "../src/platforms/telegram/telegram-payments.handler.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * Подтверждение оплаты Stars (docs/34-stage3-plan.md, WP5, п. 6–8).
 * Проверяется то, где платежи обычно ломаются: оплата по чужому или
 * устаревшему счёту, повтор подтверждения от Telegram, вторая оплата того же
 * продолжения и проверка, опоздавшая за десять секунд из-за чужой команды.
 */

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const PLAYER_ID = 555_000_111;

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

/** Второй шанс — покупка с забегом: у неё `runId` есть всегда. */
type ContinuePurchase = StoredPurchase & { runId: string };

function pending(patch: Partial<ContinuePurchase> = {}): ContinuePurchase {
  return {
    purchaseId: randomUUID(),
    accountId: randomUUID(),
    product: "continue_run",
    runId: randomUUID(),
    continueNo: 1,
    elapsedSec: 125,
    sku: null,
    priceStars: 3,
    chargedStars: 3,
    mode: "live",
    status: "pending",
    telegramChargeId: null,
    invoicedAt: new Date(NOW - 60_000),
    paidAt: null,
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

function query(purchase: StoredPurchase, patch: Partial<PreCheckout> = {}): PreCheckout {
  return { platform: "telegram", queryId: "q-1", payerId: String(PLAYER_ID), currency: "XTR", totalAmount: purchase.chargedStars, payload: purchase.purchaseId, ...patch };
}

describe("предварительная проверка оплаты", () => {
  const view = (purchase: StoredPurchase, runFinished = false, continueTaken = false, subscriptionLive = false) => ({
    purchase,
    platformUserId: String(PLAYER_ID),
    runFinished,
    continueTaken,
    subscriptionLive,
  });

  /** VIP без забега: ни `runId`, ни номера продолжения — только товар. */
  const vip = (patch: Partial<StoredPurchase> = {}): StoredPurchase => ({
    ...pending(),
    product: "vip",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "vip",
    priceStars: 700,
    chargedStars: 700,
    ...patch,
  });

  it("пропускает оплату своего свежего счёта на ту же сумму", () => {
    const purchase = pending();
    expect(decideCheckout(view(purchase), query(purchase), NOW, true)).toEqual({ ok: true });
  });

  it.each([
    ["оплата выключена", (p: StoredPurchase) => decideCheckout(view(p), query(p), NOW, false), "disabled"],
    ["счёта нет", (p: StoredPurchase) => decideCheckout(null, query(p), NOW, true), "unknown_invoice"],
    ["счёт переслали другому игроку", (p: StoredPurchase) => decideCheckout(view(p), query(p, { payerId: "42" }), NOW, true), "foreign_user"],
    ["сумма не та, что в последнем счёте", (p: StoredPurchase) => decideCheckout(view(p), query(p, { totalAmount: 1 }), NOW, true), "price_mismatch"],
    ["валюта не звёзды", (p: StoredPurchase) => decideCheckout(view(p), query(p, { currency: "USD" }), NOW, true), "price_mismatch"],
    ["счёт старше получаса", (p: StoredPurchase) => decideCheckout(view(p), query(p), NOW + 30 * 60_000, true), "stale_invoice"],
    ["забег уже закончен", (p: StoredPurchase) => decideCheckout(view(p, true), query(p), NOW, true), "run_finished"],
    ["продолжение уже взято за рекламу", (p: StoredPurchase) => decideCheckout(view(p, false, true), query(p), NOW, true), "continue_taken"],
  ])("отказывает: %s", (_name, decide, reason) => {
    expect(decide(pending())).toEqual({ ok: false, reason });
  });

  it("отказывает во второй оплате уже оплаченного продолжения", () => {
    const paid = pending({ status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    expect(decideCheckout(view(paid), query(paid), NOW, true)).toEqual({ ok: false, reason: "already_paid" });
  });

  describe("вторая подписка VIP (T-0025)", () => {
    it("новая подписка, пока у владельца идёт VIP с продлением, — отказ `subscription_active`", () => {
      const purchase = vip();
      expect(decideCheckout(view(purchase, false, false, true), query(purchase), NOW, true)).toEqual({ ok: false, reason: "subscription_active" });
    });

    it("та же покупка без идущего VIP с продлением проходит", () => {
      const purchase = vip();
      expect(decideCheckout(view(purchase, false, false, false), query(purchase), NOW, true)).toEqual({ ok: true });
    });

    it("продление действующей подписки проходит, даже когда VIP идёт и продлевается: площадка спишет его в любом случае", () => {
      const first = vip({ status: "paid", paidAt: new Date(NOW - 30 * 86_400_000), telegramChargeId: "charge-1" });
      expect(decideCheckout(view(first, false, false, true), query(first), NOW, true)).toEqual({ ok: true });
    });

    it("продление с чужой суммой по-прежнему отказ: цену проверяют и у продления", () => {
      const first = vip({ status: "paid", paidAt: new Date(NOW - 30 * 86_400_000), telegramChargeId: "charge-1" });
      expect(decideCheckout(view(first, false, false, true), query(first, { totalAmount: 1 }), NOW, true)).toEqual({ ok: false, reason: "price_mismatch" });
    });

    it("товар магазина при идущем VIP проходит: отказ касается только подписок", () => {
      const purchase = { ...vip(), product: "shop_item" as const, sku: "gems_60", priceStars: 50, chargedStars: 50 };
      expect(decideCheckout(view(purchase, false, false, true), query(purchase), NOW, true)).toEqual({ ok: true });
    });

    it("второй шанс при идущем VIP проходит", () => {
      const purchase = pending();
      expect(decideCheckout(view(purchase, false, false, true), query(purchase), NOW, true)).toEqual({ ok: true });
    });

    it("отказ идёт после «уже оплачено»: оплаченную вторую подписку не называют вторым счётом", () => {
      const paid = vip({ status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-2", renewalOf: randomUUID() });
      expect(decideCheckout(view(paid, false, false, true), query(paid), NOW, true)).toEqual({ ok: false, reason: "already_paid" });
    });

    it("текст отказа — для игрока: что случилось и что делать", () => {
      const decision = decideCheckout(view(vip(), false, false, true), query(vip()), NOW, true);
      expect(answerOf(decision)).toEqual({ ok: false, errorMessage: "VIP уже действует — вторая подписка не нужна. Вернитесь в игру." });
    });
  });

  describe("покупки аккаунту закрыты (T-0024)", () => {
    it("обычный счёт при закрытых покупках — отказ `purchases_closed`", () => {
      const purchase = pending();
      expect(decideCheckout(view(purchase), query(purchase), NOW, true, true)).toEqual({ ok: false, reason: "purchases_closed" });
    });

    it("счёт магазина и первая оплата VIP тоже закрыты", () => {
      const shop = { ...vip(), product: "shop_item" as const, sku: "gems_60", priceStars: 50, chargedStars: 50 };
      expect(decideCheckout(view(shop), query(shop), NOW, true, true)).toEqual({ ok: false, reason: "purchases_closed" });
      expect(decideCheckout(view(vip()), query(vip()), NOW, true, true)).toEqual({ ok: false, reason: "purchases_closed" });
    });

    it("продление действующей подписки проходит: площадка спишет его в любом случае, а выключает его отзыв", () => {
      const first = vip({ status: "paid", paidAt: new Date(NOW - 30 * 86_400_000), telegramChargeId: "charge-1" });
      expect(decideCheckout(view(first), query(first), NOW, true, true)).toEqual({ ok: true });
    });

    it("без параметра — прежнее поведение: открытые покупки проходят", () => {
      const purchase = pending();
      expect(decideCheckout(view(purchase), query(purchase), NOW, true)).toEqual({ ok: true });
      expect(decideCheckout(view(purchase), query(purchase), NOW, true, false)).toEqual({ ok: true });
    });

    it("отказ стоит после продления и перед «уже оплачено»", () => {
      const paid = pending({ status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
      expect(decideCheckout(view(paid), query(paid), NOW, true, true)).toEqual({ ok: false, reason: "purchases_closed" });
      expect(decideCheckout(view(paid), query(paid), NOW, true, false)).toEqual({ ok: false, reason: "already_paid" });
    });

    it("раньше стоят: оплата выключена, счёта нет, чужой игрок", () => {
      const purchase = pending();
      expect(decideCheckout(view(purchase), query(purchase), NOW, false, true)).toEqual({ ok: false, reason: "disabled" });
      expect(decideCheckout(null, query(purchase), NOW, true, true)).toEqual({ ok: false, reason: "unknown_invoice" });
      expect(decideCheckout(view(purchase), query(purchase, { payerId: "42" }), NOW, true, true)).toEqual({ ok: false, reason: "foreign_user" });
    });

    it("текст отказа — для игрока: что случилось и что делать", () => {
      const decision = decideCheckout(view(pending()), query(pending()), NOW, true, true);
      expect(answerOf(decision)).toEqual({ ok: false, errorMessage: "Покупки для этого аккаунта закрыты — подробности в игре." });
    });
  });
});

describe("подтверждение оплаты", () => {
  let purchases: MemoryPurchasesRepository;
  let api: FakeStarsApi;
  let confirmation: PaymentConfirmation;
  let purchase: ContinuePurchase;

  function payment(patch: Partial<ConfirmedPayment> = {}): ConfirmedPayment {
    return { platform: "telegram", chargeId: "charge-1", payload: purchase.purchaseId, payerId: String(PLAYER_ID), currency: "XTR", totalAmount: 3, ...patch };
  }

  beforeEach(() => {
    purchases = new MemoryPurchasesRepository();
    api = new FakeStarsApi();
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(api), switchesOf(config()));
    purchase = pending();
    purchases.rows.set(purchase.purchaseId, purchase);
    purchases.owners.set(purchase.accountId, String(PLAYER_ID));
  });

  it("отвечает Telegram на проверку — и отказом с текстом для игрока", async () => {
    await confirmation.answerCheckout(query(purchase), NOW);
    await confirmation.answerCheckout(query(purchase, { queryId: "q-2", payload: "не-uuid" }), NOW);

    expect(api.answers).toEqual([
      { queryId: "q-1", answer: { ok: true } },
      { queryId: "q-2", answer: { ok: false, errorMessage: expect.stringContaining("Счёт не найден") } },
    ]);
  });

  it("вторая подписка VIP: проверка спрашивает репозиторий и отказывает текстом для игрока; без идущего VIP — пускает", async () => {
    const subscription = { ...pending(), product: "vip" as const, runId: null, continueNo: null, elapsedSec: null, sku: "vip", priceStars: 700, chargedStars: 700 };
    purchases.rows.set(subscription.purchaseId, subscription);
    purchases.owners.set(subscription.accountId, String(PLAYER_ID));
    purchases.subscriptionLive = true;

    await expect(confirmation.answerCheckout(query(subscription), NOW)).resolves.toEqual({ ok: false, reason: "subscription_active" });
    expect(api.answers[0]?.answer).toEqual({ ok: false, errorMessage: "VIP уже действует — вторая подписка не нужна. Вернитесь в игру." });

    purchases.subscriptionLive = false;
    await expect(confirmation.answerCheckout(query(subscription, { queryId: "q-2" }), NOW)).resolves.toEqual({ ok: true });
  });

  it("оба чтения покупки идут по часам своего вызова: идёт ли VIP, считается на момент проверки", async () => {
    const asked: number[] = [];
    const original = purchases.checkout.bind(purchases);
    purchases.checkout = async (purchaseId: string, at = new Date()) => {
      asked.push(at.getTime());
      return await original(purchaseId, at);
    };

    await confirmation.answerCheckout(query(purchase), NOW);
    await confirmation.subscriptionChanged({ platform: "telegram", payload: purchase.purchaseId, payerId: String(PLAYER_ID), state: "cancelled" }, NOW + 5_000);

    expect(asked).toEqual([NOW, NOW + 5_000]);
  });

  it("база не ответила — отказ «попробуйте ещё раз», а не деньги вслепую", async () => {
    purchases.checkout = async () => Promise.reject(new Error("connect ECONNREFUSED"));

    await expect(confirmation.answerCheckout(query(purchase), NOW)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(api.answers[0]?.answer).toEqual({ ok: false, errorMessage: expect.stringContaining("попробуйте ещё раз") });
  });

  it("выдаёт продолжение по подтверждению и записывает, сколько списано на самом деле", async () => {
    await expect(confirmation.confirm(payment({ totalAmount: 3 }), NOW)).resolves.toMatchObject({ kind: "paid" });

    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "paid", telegramChargeId: "charge-1", chargedStars: 3, paidAt: new Date(NOW) });
    expect(await purchases.grantedContinues(purchase.runId)).toBe(1);
  });

  it("событие оплаты несёт вид товара: слушатели отличают донат от покупки (Р109); повтор события не рождает", async () => {
    const hooks = new PaymentsHooks();
    const heard: { purchaseId: string; product: string; mode: string }[] = [];
    hooks.onPaid("test", async (paid) => void heard.push({ purchaseId: paid.purchaseId, product: paid.product, mode: paid.mode }));
    const listening = new PaymentConfirmation(config(), purchases, starsProviders(api), switchesOf(config()), hooks);
    const donation: StoredPurchase = { ...pending(), product: "donation", runId: null, continueNo: null, elapsedSec: null, sku: "donation", priceStars: 50, chargedStars: 50 };
    const shop: StoredPurchase = { ...donation, purchaseId: randomUUID(), product: "shop_item", sku: "gems_60" };
    for (const row of [donation, shop]) {
      purchases.rows.set(row.purchaseId, row);
      purchases.owners.set(row.accountId, String(PLAYER_ID));
    }

    await listening.confirm(payment({ chargeId: "charge-d", payload: donation.purchaseId, totalAmount: 50 }), NOW);
    await listening.confirm(payment({ chargeId: "charge-s", payload: shop.purchaseId, totalAmount: 50 }), NOW);
    await listening.confirm(payment({ chargeId: "charge-d", payload: donation.purchaseId, totalAmount: 50 }), NOW + 1_000);
    await listening.confirm(payment({ chargeId: "charge-c", payload: purchase.purchaseId }), NOW);

    expect(heard).toEqual([
      { purchaseId: donation.purchaseId, product: "donation", mode: "live" },
      { purchaseId: shop.purchaseId, product: "shop_item", mode: "live" },
      { purchaseId: purchase.purchaseId, product: "continue_run", mode: "live" },
    ]);
  });

  it("повтор подтверждения от Telegram ничего не удваивает", async () => {
    await confirmation.confirm(payment(), NOW);
    await expect(confirmation.confirm(payment(), NOW + 1000)).resolves.toMatchObject({ kind: "duplicate" });

    expect(purchases.rows.get(purchase.purchaseId)?.paidAt).toEqual(new Date(NOW));
    expect(await purchases.grantedContinues(purchase.runId)).toBe(1);
  });

  it("вторая оплата того же продолжения не перезаписывает первую", async () => {
    await confirmation.confirm(payment(), NOW);

    await expect(confirmation.confirm(payment({ chargeId: "charge-2" }), NOW)).resolves.toMatchObject({ kind: "already_paid" });
    expect(purchases.rows.get(purchase.purchaseId)?.telegramChargeId).toBe("charge-1");
  });

  it("оплата без покупки не выдаёт ничего", async () => {
    await expect(confirmation.confirm(payment({ payload: randomUUID() }), NOW)).resolves.toEqual({ kind: "unknown" });
    await expect(confirmation.confirm(payment({ payload: "мусор" }), NOW)).resolves.toEqual({ kind: "unknown" });
  });

  it("возврат не по нашей воле записывается с причиной, повтор — нет", async () => {
    await confirmation.confirm(payment(), NOW);

    await confirmation.refunded("charge-1", NOW + 60_000);
    await confirmation.refunded("charge-1", NOW + 120_000);
    await expect(confirmation.refunded("charge-unknown", NOW)).resolves.toBeUndefined();

    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "external", refundedAt: new Date(NOW + 60_000) });
    // Продолжение было выдано и остаётся выданным: к возврату его давно потратили.
    expect(await purchases.grantedContinues(purchase.runId)).toBe(1);
    await expect(purchases.refundStats(purchase.accountId)).resolves.toEqual({ paid: 1, refunded: 1 });
  });
});

describe("обновления оплаты в боте", () => {
  function privateMessage(fields: Record<string, unknown>): TelegramUpdate {
    return updateSchema.parse({ update_id: 10, message: { message_id: 1, date: 1, chat: { id: PLAYER_ID, type: "private" }, from: { id: PLAYER_ID, is_bot: false }, ...fields } });
  }

  const charge = { currency: "XTR", total_amount: 3, invoice_payload: randomUUID(), telegram_payment_charge_id: "charge-1" };

  function setup() {
    const calls: string[] = [];
    const confirmed: ConfirmedPayment[] = [];
    const refunded: string[] = [];
    const confirmation = {
      answerCheckout: async (checkout: PreCheckout) => void calls.push(`checkout:${checkout.payload}`),
      refunded: async (chargeId: string) => void calls.push(`refunded:${chargeId}`),
    } as unknown as PaymentConfirmation;
    const queue = {
      enabled: true,
      confirm: async (payment: ConfirmedPayment) => void confirmed.push(payment),
      refunded: async (chargeId: string) => void refunded.push(chargeId),
    } as unknown as PaymentsQueue;
    const router = new BotRouter();
    const handler = new TelegramPaymentsHandler(router, confirmation, queue);
    handler.onModuleInit();
    return { router, calls, confirmed, refunded };
  }

  it("бот читает предварительную проверку оплаты: без неё Telegram не прислал бы её вовсе", () => {
    expect(ALLOWED_UPDATES).toContain("pre_checkout_query");
  });

  it("проверку разбирает оплата, подтверждение и возврат — через очередь, команды — нет", async () => {
    const { router, calls, confirmed, refunded } = setup();

    await router.dispatch(
      updateSchema.parse({ update_id: 9, pre_checkout_query: { id: "q-1", from: { id: PLAYER_ID, is_bot: false }, currency: "XTR", total_amount: 3, invoice_payload: "p-1" } }),
    );
    await router.dispatch(privateMessage({ successful_payment: { ...charge, provider_payment_charge_id: "" } }));
    await router.dispatch(privateMessage({ refunded_payment: charge }));
    await router.dispatch(privateMessage({ text: "/start" }));

    // Возврат по спору, как и подтверждение, ложится в очередь: смещение опроса уже
    // сохранено, и упавшая запись в базу не должна терять отметку насовсем.
    expect(calls).toEqual(["checkout:p-1"]);
    expect(refunded).toEqual(["charge-1"]);
    expect(confirmed).toEqual([{ platform: "telegram", chargeId: "charge-1", payload: charge.invoice_payload, payerId: String(PLAYER_ID), currency: "XTR", totalAmount: 3 }]);
  });
});

describe("очередь оплаты", () => {
  it("без Redis подтверждение пишется сразу, а упавшая запись не роняет чтение обновлений", async () => {
    const confirmed: string[] = [];
    let failing = false;
    const confirmation = {
      confirm: async (payment: ConfirmedPayment) => {
        if (failing) throw new Error("база недоступна");
        confirmed.push(payment.chargeId);
        return { kind: "paid", purchase: pending({ status: "paid", telegramChargeId: payment.chargeId }), runFinished: false, continueTaken: false };
      },
    } as unknown as PaymentConfirmation;
    // Очередь не поднята — как при недоступном Redis.
    const queue = new PaymentsQueue(config(), confirmation, new PaymentRefunds(new MemoryPurchasesRepository(), starsProviders(), new PurchaseRevocation()), new RunsHooks(), starsProviders(), new PurchaseFulfillment(), new MemoryPurchasesRepository());
    const payment: ConfirmedPayment = { platform: "telegram", chargeId: "charge-1", payload: randomUUID(), payerId: String(PLAYER_ID), currency: "XTR", totalAmount: 3 };

    await queue.confirm(payment);
    failing = true;
    await expect(queue.confirm({ ...payment, chargeId: "charge-2" })).resolves.toBeUndefined();

    expect(confirmed).toEqual(["charge-1"]);
  });
});

describe("возвраты звёзд", () => {
  let purchases: MemoryPurchasesRepository;
  let refundApi: FakeStarsApi;
  let refunds: PaymentRefunds;
  let confirmation: PaymentConfirmation;
  let hooks: RunsHooks;
  let queue: PaymentsQueue;

  function purchaseIn(mode: "live" | "test", patch: Partial<ContinuePurchase> = {}): ContinuePurchase {
    const purchase = pending({ mode, chargedStars: mode === "test" ? 1 : 3, ...patch });
    purchases.rows.set(purchase.purchaseId, purchase);
    purchases.owners.set(purchase.accountId, String(PLAYER_ID));
    return purchase;
  }

  function payment(purchase: StoredPurchase, chargeId = "charge-1"): ConfirmedPayment {
    return { platform: "telegram", chargeId, payload: purchase.purchaseId, payerId: String(PLAYER_ID), currency: "XTR", totalAmount: purchase.chargedStars };
  }

  beforeEach(() => {
    purchases = new MemoryPurchasesRepository();
    refundApi = new FakeStarsApi();
    refunds = new PaymentRefunds(purchases, starsProviders(refundApi), new PurchaseRevocation());
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(refundApi), switchesOf(config()));
    hooks = new RunsHooks();
    // Очередь без Redis выполняет задания сразу — так видно всю цепочку.
    queue = new PaymentsQueue(config(), confirmation, refunds, hooks, starsProviders(refundApi), new PurchaseFulfillment(), purchases);
    queue.onModuleInit();
  });

  it("тестовая оплата: звезда возвращается сразу, продолжение засчитано", async () => {
    const purchase = purchaseIn("test");

    await queue.confirm(payment(purchase));

    expect(refundApi.refunded).toEqual([{ userId: PLAYER_ID, chargeId: "charge-1" }]);
    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "test_mode" });
    expect(await purchases.grantedContinues(purchase.runId)).toBe(1);
  });

  it("настоящая оплата живого забега не возвращается", async () => {
    const purchase = purchaseIn("live");

    await queue.confirm(payment(purchase));

    expect(refundApi.refunded).toEqual([]);
    expect(purchases.rows.get(purchase.purchaseId)?.status).toBe("paid");
  });

  it("оплата пришла, когда забег уже закончен: товар не выдан — звёзды назад", async () => {
    const purchase = purchaseIn("live");
    purchases.finishedRuns.add(purchase.runId);

    await queue.confirm(payment(purchase));

    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "unused" });
  });

  it("оплата пришла, когда это продолжение уже взяли за рекламу, — звёзды назад", async () => {
    const purchase = purchaseIn("live");
    purchases.adContinues.add(`${String(purchase.runId)}:1`);

    await queue.confirm(payment(purchase));

    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "unused" });
  });

  it("забег записан без взятого продолжения, за которое заплатили, — звёзды назад", async () => {
    const purchase = purchaseIn("live");
    await queue.confirm(payment(purchase));

    await hooks.emit({
      runId: purchase.runId,
      accountId: purchase.accountId,
      difficulty: "normal",
      outcome: "died",
      survivalSec: 125,
      level: 5,
      enemiesKilled: 90,
      startingWeaponId: "knife",
      weapons: [],
      boosts: [],
      xpCollected: null,
      deathCause: "swarm_rat",
      cheats: false,
      continues: 0,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt: new Date(NOW),
    });

    expect(refundApi.refunded).toEqual([{ userId: PLAYER_ID, chargeId: "charge-1" }]);
    expect(purchases.rows.get(purchase.purchaseId)?.refundReason).toBe("unused");
  });

  it("вторая оплата того же продолжения возвращается, первая остаётся", async () => {
    const purchase = purchaseIn("live");
    await queue.confirm(payment(purchase, "charge-1"));

    await queue.confirm(payment(purchase, "charge-2"));

    expect(refundApi.refunded).toEqual([{ userId: PLAYER_ID, chargeId: "charge-2" }]);
    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "paid", telegramChargeId: "charge-1" });
  });

  it("повтор уже сделанного возврата — не ошибка", async () => {
    const purchase = purchaseIn("test", { status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    const order = await purchases.requestRefund(purchase.purchaseId, "test_mode", new Date(NOW));
    if (order === null) throw new Error("возврат не заказан");
    refundApi.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_ALREADY_REFUNDED", null);

    await expect(refunds.refund(order)).resolves.toBeUndefined();
    expect(purchases.rows.get(purchase.purchaseId)?.status).toBe("refunded");
  });

  it("сбой сети — повтор через очередь, отказ Telegram — разбор человеку, а не вечный повтор", async () => {
    const purchase = purchaseIn("test", { status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    const order = await purchases.requestRefund(purchase.purchaseId, "test_mode", new Date(NOW));
    if (order === null) throw new Error("возврат не заказан");

    refundApi.refundFailWith = new TelegramApiError("refundStarPayment", 0, "сеть недоступна", null);
    await expect(refunds.refund(order)).rejects.toThrow(TelegramApiError);
    refundApi.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_NOT_FOUND", null);
    await expect(refunds.refund(order)).rejects.toMatchObject({ name: "UnrecoverableError" });

    // Возврат не прошёл — заказ остаётся в базе, после перезапуска его поднимут.
    await expect(refunds.pending(10)).resolves.toEqual([order]);
  });
});

describe("тестовая оплата в конфигурации", () => {
  it("вне разработки бэкенд с ней не стартует: продолжение в проде стоило бы звезду", () => {
    expect(() => config({ PAYMENTS_TEST_MODE: "true" })).toThrow(/PAYMENTS_TEST_MODE/);
    expect(() => config({ NODE_ENV: "production", PAYMENTS_TEST_MODE: "true" })).toThrow(/PAYMENTS_TEST_MODE/);
    expect(config({ NODE_ENV: "development", PAYMENTS_TEST_MODE: "true" }).payments.testMode).toBe(true);
  });
});


describe("внешний возврат забирает остаток покупки (T-0023)", () => {
  let purchases: MemoryPurchasesRepository;
  let revocation: PurchaseRevocation;
  let confirmation: PaymentConfirmation;
  let revoked: { purchaseId: string; at: Date }[];
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  /** Оплаченная покупка товара магазина: возврат её заберёт `shop_item`-отзыв. */
  function paidShopItem(patch: Partial<StoredPurchase> = {}): StoredPurchase {
    const purchase: StoredPurchase = {
      ...pending({ chargedStars: 50, priceStars: 50, status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" }),
      product: "shop_item",
      runId: null,
      continueNo: null,
      elapsedSec: null,
      sku: "starter",
      fulfilledAt: new Date(NOW),
      ...patch,
    };
    purchases.rows.set(purchase.purchaseId, purchase);
    return purchase;
  }

  beforeEach(() => {
    purchases = new MemoryPurchasesRepository();
    revocation = new PurchaseRevocation();
    revoked = [];
    revocation.register("shop_item", async (purchase, at) => {
      revoked.push({ purchaseId: purchase.purchaseId, at });
      return { lines: ["gems: 120 из 150"] };
    });
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(new FakeStarsApi()), switchesOf(config()), new PaymentsHooks(), revocation);
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
        const fields = JSON.parse(String(line)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("внешний возврат, первый вызов: отзыв вызван с покупкой и моментом возврата, в логе payment_refunded — что забрано", async () => {
    const purchase = paidShopItem();

    await confirmation.refunded("charge-1", NOW + 60_000);

    expect(revoked).toEqual([{ purchaseId: purchase.purchaseId, at: new Date(NOW + 60_000) }]);
    const entry = logged.find((item) => item.event === "payment_refunded");
    expect(entry).toMatchObject({ level: "warn", fields: { purchaseId: purchase.purchaseId, reason: "external", revoked: ["gems: 120 из 150"] } });
  });

  it("внешний возврат, повторный вызов: отзыв вызван снова — с тем же моментом, а лог не повторяется", async () => {
    const purchase = paidShopItem();
    await confirmation.refunded("charge-1", NOW + 60_000);

    await confirmation.refunded("charge-1", NOW + 600_000);

    expect(revoked).toEqual([
      { purchaseId: purchase.purchaseId, at: new Date(NOW + 60_000) },
      { purchaseId: purchase.purchaseId, at: new Date(NOW + 60_000) },
    ]);
    expect(logged.filter((item) => item.event === "payment_refunded")).toHaveLength(1);
  });

  it("первая попытка отметила возврат и упала на отзыве — повтор доделывает отзыв", async () => {
    const purchase = paidShopItem();
    let failing = true;
    revocation = new PurchaseRevocation();
    revocation.register("shop_item", async (bought, at) => {
      if (failing) throw new Error("кошелёк недоступен");
      revoked.push({ purchaseId: bought.purchaseId, at });
      return { lines: ["gems: 150 из 150"] };
    });
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(new FakeStarsApi()), switchesOf(config()), new PaymentsHooks(), revocation);

    await expect(confirmation.refunded("charge-1", NOW + 60_000)).rejects.toThrow("кошелёк недоступен");
    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "external" });
    expect(revoked).toEqual([]);

    failing = false;
    await confirmation.refunded("charge-1", NOW + 120_000);

    // Время отзыва — первое, которым возврат был отмечен, а не время повтора.
    expect(revoked).toEqual([{ purchaseId: purchase.purchaseId, at: new Date(NOW + 60_000) }]);
  });

  it("наш возврат ничего не забирает: причина, заказанная нами, не `external`", async () => {
    const purchase = paidShopItem();
    await purchases.requestRefund(purchase.purchaseId, "undeliverable", new Date(NOW));

    await confirmation.refunded("charge-1", NOW + 60_000);

    expect(revoked).toEqual([]);
    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ refundReason: "undeliverable" });
    expect(logged.find((item) => item.event === "payment_refunded")?.fields).not.toHaveProperty("revoked");
  });

  it("лишняя оплата (возвращается только она) — товар выдан по первой оплате и остаётся", async () => {
    const purchase = paidShopItem();
    await purchases.requestRefund(purchase.purchaseId, "unused", new Date(NOW));

    await confirmation.refunded("charge-1", NOW + 60_000);

    expect(revoked).toEqual([]);
  });

  it("возврат без совпадения: отзыв не вызван, в логе refund_unmatched", async () => {
    paidShopItem();

    await confirmation.refunded("charge-unknown", NOW + 60_000);

    expect(revoked).toEqual([]);
    expect(logged.map((item) => item.event)).toContain("refund_unmatched");
  });

  it("второй шанс: владельца у отзыва нет — возврат записан, ничего не забрано, обработка не падает", async () => {
    const purchase = pending({ status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    purchases.rows.set(purchase.purchaseId, purchase);

    await expect(confirmation.refunded("charge-1", NOW + 60_000)).resolves.toBeUndefined();

    expect(revoked).toEqual([]);
    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "external" });
    expect(logged.find((item) => item.event === "payment_refunded")?.fields).toMatchObject({ revoked: ["ничего — товар не забирается"] });
  });

  it("отзыв бросил — refunded бросает: задание очереди оплаты повторит обработку", async () => {
    paidShopItem();
    revocation = new PurchaseRevocation();
    revocation.register("shop_item", async () => Promise.reject(new Error("кошелёк недоступен")));
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(new FakeStarsApi()), switchesOf(config()), new PaymentsHooks(), revocation);

    await expect(confirmation.refunded("charge-1", NOW)).rejects.toThrow("кошелёк недоступен");
  });
});

/** Строка действующего ограничения: сверка нужна лишь «есть ли», подробности сервису ограничений. */
function closedRow(accountId: string): RestrictionRow {
  return {
    restrictionId: randomUUID(),
    accountId,
    kind: "purchases",
    startsAt: new Date(NOW),
    endsAt: null,
    reason: "payment_refund",
    comment: null,
    notify: true,
    imposedBy: null,
    liftedAt: null,
    liftedBy: null,
    liftComment: null,
    settledAt: null,
  };
}

/** Ограничения для оплаты: «закрыто ли» и «закрыть» — подменой, которая помнит вызовы. */
function restrictionsFake() {
  const closed = new Set<string>();
  const asked: { accountId: string; kind: string; at: Date }[] = [];
  const imposed: { accountId: string; kind: string; reason: string; comment: string; at: Date }[] = [];
  const state = { statusFailWith: null as Error | null, imposeFailWith: null as Error | null, statusHangs: false };
  const gate = {
    status: async (accountId: string, kind: string, at: Date = new Date()): Promise<RestrictionRow | null> => {
      asked.push({ accountId, kind, at });
      if (state.statusHangs) return await new Promise<never>(() => undefined);
      if (state.statusFailWith !== null) throw state.statusFailWith;
      return closed.has(accountId) ? closedRow(accountId) : null;
    },
  };
  const system = {
    imposeBySystem: async (accountId: string, kind: string, reason: string, comment: string, at: Date = new Date()): Promise<void> => {
      if (state.imposeFailWith !== null) throw state.imposeFailWith;
      imposed.push({ accountId, kind, reason, comment, at });
      closed.add(accountId);
    },
  };
  return { gate, system, closed, asked, imposed, state };
}

describe("предварительная проверка и закрытые покупки (T-0024)", () => {
  let purchases: MemoryPurchasesRepository;
  let api: FakeStarsApi;
  let restrictions: ReturnType<typeof restrictionsFake>;
  let confirmation: PaymentConfirmation;
  let purchase: ContinuePurchase;

  beforeEach(() => {
    purchases = new MemoryPurchasesRepository();
    api = new FakeStarsApi();
    restrictions = restrictionsFake();
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(api), switchesOf(config()), new PaymentsHooks(), new PurchaseRevocation(), restrictions.gate as never, restrictions.system as never);
    purchase = pending();
    purchases.rows.set(purchase.purchaseId, purchase);
    purchases.owners.set(purchase.accountId, String(PLAYER_ID));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("покупки закрыты — Telegram получает отказ с текстом для игрока, а не деньги", async () => {
    restrictions.closed.add(purchase.accountId);

    await expect(confirmation.answerCheckout(query(purchase), NOW)).resolves.toEqual({ ok: false, reason: "purchases_closed" });

    expect(api.answers).toEqual([{ queryId: "q-1", answer: { ok: false, errorMessage: "Покупки для этого аккаунта закрыты — подробности в игре." } }]);
  });

  it("спрашивает про аккаунт покупки, вид «purchases» и момент своего вызова", async () => {
    await confirmation.answerCheckout(query(purchase), NOW);

    expect(restrictions.asked).toEqual([{ accountId: purchase.accountId, kind: "purchases", at: new Date(NOW) }]);
    expect(api.answers[0]?.answer).toEqual({ ok: true });
  });

  it("закрыт другой аккаунт — этот платит", async () => {
    restrictions.closed.add(randomUUID());

    await expect(confirmation.answerCheckout(query(purchase), NOW)).resolves.toEqual({ ok: true });
  });

  it("продление действующей подписки проходит, даже когда покупки закрыты", async () => {
    const first = { ...pending(), product: "vip" as const, runId: null, continueNo: null, elapsedSec: null, sku: "vip", priceStars: 700, chargedStars: 700, status: "paid" as const, paidAt: new Date(NOW - 86_400_000), telegramChargeId: "charge-1", fulfilledAt: new Date(NOW - 86_400_000) };
    purchases.rows.set(first.purchaseId, first);
    purchases.owners.set(first.accountId, String(PLAYER_ID));
    restrictions.closed.add(first.accountId);

    await expect(confirmation.answerCheckout(query(first, { queryId: "q-2" }), NOW)).resolves.toEqual({ ok: true });
  });

  it("ограничения не прочитались — отказ «попробуйте ещё раз», а не деньги вслепую", async () => {
    restrictions.state.statusFailWith = new Error("redis недоступен");
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((line: unknown) => void logged.push(String(JSON.parse(String(line)).event)));

    await expect(confirmation.answerCheckout(query(purchase), NOW)).resolves.toEqual({ ok: false, reason: "unavailable" });

    expect(api.answers[0]?.answer).toEqual({ ok: false, errorMessage: expect.stringContaining("попробуйте ещё раз") });
    expect(logged).toContain("pre_checkout_failed");
  });

  it("ограничения не ответили за срок чтения — тот же отказ, Telegram не ждёт десять секунд", async () => {
    vi.useFakeTimers();
    restrictions.state.statusHangs = true;
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const decision = confirmation.answerCheckout(query(purchase), NOW);
    await vi.advanceTimersByTimeAsync(3_100);

    await expect(decision).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("без сервиса ограничений (тесты, где его нет) проверка идёт как прежде", async () => {
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(api), switchesOf(config()));

    await expect(confirmation.answerCheckout(query(purchase), NOW)).resolves.toEqual({ ok: true });
  });
});

describe("внешний возврат закрывает покупки аккаунту (T-0024)", () => {
  let purchases: MemoryPurchasesRepository;
  let restrictions: ReturnType<typeof restrictionsFake>;
  let hooks: PaymentsHooks;
  let cards: ExternalRefund[];
  let confirmation: PaymentConfirmation;
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  function paidShopItem(patch: Partial<StoredPurchase> = {}): StoredPurchase {
    const purchase: StoredPurchase = {
      ...pending({ chargedStars: 50, priceStars: 50, status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" }),
      product: "shop_item",
      runId: null,
      continueNo: null,
      elapsedSec: null,
      sku: "starter",
      fulfilledAt: new Date(NOW),
      ...patch,
    };
    purchases.rows.set(purchase.purchaseId, purchase);
    return purchase;
  }

  function build(revocation = new PurchaseRevocation()): PaymentConfirmation {
    return new PaymentConfirmation(config(), purchases, starsProviders(new FakeStarsApi()), switchesOf(config()), hooks, revocation, restrictions.gate as never, restrictions.system as never);
  }

  beforeEach(() => {
    purchases = new MemoryPurchasesRepository();
    restrictions = restrictionsFake();
    hooks = new PaymentsHooks();
    cards = [];
    hooks.onExternalRefund("test", async (refund) => void cards.push(refund));
    const revocation = new PurchaseRevocation();
    revocation.register("shop_item", async () => ({ lines: ["gems: 120 из 150"] }));
    confirmation = build(revocation);
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
        const fields = JSON.parse(String(line)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("внешний, первый раз: покупки закрыты системой, причина «Возврат оплаты», комментарий несёт покупку", async () => {
    const purchase = paidShopItem();

    await confirmation.refunded("charge-1", NOW + 60_000);

    expect(restrictions.imposed).toEqual([
      { accountId: purchase.accountId, kind: "purchases", reason: "payment_refund", comment: `Возврат звёзд за покупку ${purchase.purchaseId}`, at: new Date(NOW + 60_000) },
    ]);
  });

  it("слушатель получает покупку, что забрано, долю возвратов аккаунта и момент возврата", async () => {
    const purchase = paidShopItem();

    await confirmation.refunded("charge-1", NOW + 60_000);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ purchase: { purchaseId: purchase.purchaseId, accountId: purchase.accountId }, revoked: ["gems: 120 из 150"], stats: { paid: 1, refunded: 1 }, at: new Date(NOW + 60_000) });
  });

  it("закрытие идёт после отзыва остатка, а карточка — после закрытия", async () => {
    paidShopItem();
    const order: string[] = [];
    const revocation = new PurchaseRevocation();
    revocation.register("shop_item", async () => (order.push("отзыв"), { lines: [] }));
    const original = restrictions.system.imposeBySystem;
    restrictions.system.imposeBySystem = async (...args) => (order.push("закрытие"), await original(...args));
    hooks.onExternalRefund("порядок", async () => void order.push("карточка"));
    confirmation = build(revocation);

    await confirmation.refunded("charge-1", NOW);

    expect(order).toEqual(["отзыв", "закрытие", "карточка"]);
  });

  it("повтор обработки того же возврата: ни второго наложения, ни второй карточки — аккаунт уже закрыт", async () => {
    paidShopItem();
    await confirmation.refunded("charge-1", NOW + 60_000);

    await confirmation.refunded("charge-1", NOW + 600_000);

    expect(restrictions.imposed).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(logged.filter((item) => item.event === "payment_refunded")).toHaveLength(1);
  });

  it("первая попытка упала на наложении — повтор закрывает покупки и шлёт карточку, а не пропускает их как «уже было»", async () => {
    const purchase = paidShopItem();
    restrictions.state.imposeFailWith = new Error("база недоступна");
    await expect(confirmation.refunded("charge-1", NOW + 60_000)).rejects.toThrow("база недоступна");
    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "external" });
    expect(cards).toEqual([]);

    restrictions.state.imposeFailWith = null;
    await confirmation.refunded("charge-1", NOW + 120_000);

    // Время — то, которым возврат отмечен впервые, как у отзыва остатка.
    expect(restrictions.imposed).toEqual([expect.objectContaining({ accountId: purchase.accountId, at: new Date(NOW + 60_000) })]);
    expect(cards).toHaveLength(1);
    expect(logged.filter((item) => item.event === "payment_refunded")).toHaveLength(1);
  });

  it("наш возврат (недоставленный товар, лишняя оплата) ничего не закрывает и карточки не шлёт", async () => {
    const undeliverable = paidShopItem();
    await purchases.requestRefund(undeliverable.purchaseId, "undeliverable", new Date(NOW));
    const extra = paidShopItem({ telegramChargeId: "charge-2" });
    await purchases.requestRefund(extra.purchaseId, "unused", new Date(NOW));

    await confirmation.refunded("charge-1", NOW + 60_000);
    await confirmation.refunded("charge-2", NOW + 60_000);

    expect(restrictions.imposed).toEqual([]);
    expect(restrictions.asked).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("возврат без совпадения: ничего не закрыто", async () => {
    paidShopItem();

    await confirmation.refunded("charge-unknown", NOW + 60_000);

    expect(restrictions.imposed).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("наложение бросило — refunded бросает: задание очереди оплаты повторит обработку", async () => {
    paidShopItem();
    restrictions.state.imposeFailWith = new Error("база недоступна");

    await expect(confirmation.refunded("charge-1", NOW)).rejects.toThrow("база недоступна");
  });

  it("упавший слушатель карточки не мешает остальным и не роняет обработку", async () => {
    paidShopItem();
    hooks.onExternalRefund("сломанный", async () => Promise.reject(new Error("чат недоступен")));
    const later: string[] = [];
    hooks.onExternalRefund("после", async () => void later.push("получил"));

    await expect(confirmation.refunded("charge-1", NOW)).resolves.toBeUndefined();

    expect(later).toEqual(["получил"]);
    expect(cards).toHaveLength(1);
    expect(logged).toContainEqual(expect.objectContaining({ level: "error", event: "listener_failed", fields: expect.objectContaining({ listener: "сломанный" }) as Record<string, unknown> }));
  });

  it("второй шанс, возвращённый через Telegram, тоже закрывает покупки: схема «купил → вернул» не зависит от товара", async () => {
    const second = pending({ status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    purchases.rows.set(second.purchaseId, second);

    await confirmation.refunded("charge-1", NOW + 60_000);

    expect(restrictions.imposed).toHaveLength(1);
    expect(cards[0]?.revoked).toEqual(["ничего — товар не забирается"]);
  });

  it("без сервиса ограничений (тесты, где его нет) возврат только записывается, как до T-0024", async () => {
    const purchase = paidShopItem();
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(new FakeStarsApi()), switchesOf(config()), hooks);

    await expect(confirmation.refunded("charge-1", NOW)).resolves.toBeUndefined();

    expect(purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded" });
    expect(restrictions.imposed).toEqual([]);
  });
});
