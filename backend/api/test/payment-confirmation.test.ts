import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { urgentFirst } from "../src/platforms/telegram/bot-poller.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { decideCheckout, type PreCheckout } from "../src/modules/payments/checkout-answer.js";
import { PaymentConfirmation, type ConfirmedPayment } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { ALLOWED_UPDATES, TelegramApiError, updateSchema, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramPaymentsHandler } from "../src/platforms/telegram/telegram-payments.handler.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";

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

function pending(patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: randomUUID(),
    accountId: randomUUID(),
    runId: randomUUID(),
    continueNo: 1,
    elapsedSec: 125,
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
    ...patch,
  };
}

function query(purchase: StoredPurchase, patch: Partial<PreCheckout> = {}): PreCheckout {
  return { platform: "telegram", queryId: "q-1", payerId: String(PLAYER_ID), currency: "XTR", totalAmount: purchase.chargedStars, payload: purchase.purchaseId, ...patch };
}

describe("предварительная проверка оплаты", () => {
  const view = (purchase: StoredPurchase, runFinished = false) => ({ purchase, platformUserId: String(PLAYER_ID), runFinished });

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
  ])("отказывает: %s", (_name, decide, reason) => {
    expect(decide(pending())).toEqual({ ok: false, reason });
  });

  it("отказывает во второй оплате уже оплаченного продолжения", () => {
    const paid = pending({ status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    expect(decideCheckout(view(paid), query(paid), NOW, true)).toEqual({ ok: false, reason: "already_paid" });
  });
});

describe("подтверждение оплаты", () => {
  let purchases: MemoryPurchasesRepository;
  let api: FakeStarsApi;
  let confirmation: PaymentConfirmation;
  let purchase: StoredPurchase;

  function payment(patch: Partial<ConfirmedPayment> = {}): ConfirmedPayment {
    return { platform: "telegram", chargeId: "charge-1", payload: purchase.purchaseId, payerId: String(PLAYER_ID), currency: "XTR", totalAmount: 3, ...patch };
  }

  beforeEach(() => {
    purchases = new MemoryPurchasesRepository();
    api = new FakeStarsApi();
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(api));
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
    const confirmation = {
      answerCheckout: async (checkout: PreCheckout) => void calls.push(`checkout:${checkout.payload}`),
      refunded: async (chargeId: string) => void calls.push(`refunded:${chargeId}`),
    } as unknown as PaymentConfirmation;
    const queue = { enabled: true, confirm: async (payment: ConfirmedPayment) => void confirmed.push(payment) } as unknown as PaymentsQueue;
    const router = new BotRouter();
    const handler = new TelegramPaymentsHandler(router, confirmation, queue);
    handler.onModuleInit();
    return { router, calls, confirmed };
  }

  it("бот читает предварительную проверку оплаты: без неё Telegram не прислал бы её вовсе", () => {
    expect(ALLOWED_UPDATES).toContain("pre_checkout_query");
  });

  it("проверку, подтверждение и возврат разбирает оплата, команды — нет", async () => {
    const { router, calls, confirmed } = setup();

    await router.dispatch(
      updateSchema.parse({ update_id: 9, pre_checkout_query: { id: "q-1", from: { id: PLAYER_ID, is_bot: false }, currency: "XTR", total_amount: 3, invoice_payload: "p-1" } }),
    );
    await router.dispatch(privateMessage({ successful_payment: { ...charge, provider_payment_charge_id: "" } }));
    await router.dispatch(privateMessage({ refunded_payment: charge }));
    await router.dispatch(privateMessage({ text: "/start" }));

    expect(calls).toEqual(["checkout:p-1", "refunded:charge-1"]);
    expect(confirmed).toEqual([{ platform: "telegram", chargeId: "charge-1", payload: charge.invoice_payload, payerId: String(PLAYER_ID), currency: "XTR", totalAmount: 3 }]);
  });

  it("в пачке обновлений проверка оплаты идёт первой, остальные — по порядку", () => {
    const start = (id: number): TelegramUpdate => ({ update_id: id, message: { message_id: id, date: 1, text: "/start", chat: { id: 1, type: "private" } } });
    const checkout: TelegramUpdate = {
      update_id: 3,
      pre_checkout_query: { id: "q", from: { id: 1, is_bot: false }, currency: "XTR", total_amount: 1, invoice_payload: "p" },
    };

    expect(urgentFirst([start(1), start(2), checkout, start(4)]).map((update) => update.update_id)).toEqual([3, 1, 2, 4]);
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
        return { kind: "paid", purchase: pending({ status: "paid", telegramChargeId: payment.chargeId }), runFinished: false };
      },
    } as unknown as PaymentConfirmation;
    // Очередь не поднята — как при недоступном Redis.
    const queue = new PaymentsQueue(config(), confirmation, new PaymentRefunds(new MemoryPurchasesRepository(), starsProviders()), new RunsHooks(), starsProviders());
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

  function purchaseIn(mode: "live" | "test", patch: Partial<StoredPurchase> = {}): StoredPurchase {
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
    refunds = new PaymentRefunds(purchases, starsProviders(refundApi));
    confirmation = new PaymentConfirmation(config(), purchases, starsProviders(refundApi));
    hooks = new RunsHooks();
    // Очередь без Redis выполняет задания сразу — так видно всю цепочку.
    queue = new PaymentsQueue(config(), confirmation, refunds, hooks, starsProviders(refundApi));
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

