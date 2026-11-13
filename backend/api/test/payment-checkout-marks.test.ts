import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CheckoutRefusal } from "../src/modules/payments/checkout-answer.js";
import { PaymentCheckoutMarks } from "../src/modules/payments/payment-checkout-marks.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";

/**
 * Последняя предварительная проверка оплаты в хронологии платежа
 * (tasks/T-0430, Р209, WP53): строка карточки, разбор строки базы и вызовы
 * к базе. Запись и чтение на живом Postgres —
 * `payment-checkout-marks.integration.test.ts`.
 */

const CHECKED_AT = new Date("2026-11-11T10:20:00.000Z");
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";

function purchase(patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: PURCHASE_ID,
    accountId: "22222222-2222-4222-8222-222222222222",
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "starter_pack",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "pending",
    telegramChargeId: null,
    invoicedAt: new Date("2026-11-11T10:00:00.000Z"),
    paidAt: null,
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

/** Строка покупки так, как её отдаёт клиент Prisma, — только две колонки отметки. */
interface MarkRow {
  checkoutAt: Date | null;
  checkoutRefusal: string | null;
}

/** Подставная база: одна покупка, запросы запоминаются. */
function fakePrisma(row: MarkRow | null) {
  const calls = { find: [] as unknown[], update: [] as unknown[] };
  const prisma = {
    purchase: {
      findUnique: async (args: unknown) => {
        calls.find.push(args);
        return row;
      },
      updateMany: async (args: unknown) => {
        calls.update.push(args);
        return { count: row === null ? 0 : 1 };
      },
    },
  };
  return { prisma, calls };
}

function build(row: MarkRow | null) {
  const { prisma, calls } = fakePrisma(row);
  const sources = new PaymentFeedSources();
  const marks = new PaymentCheckoutMarks(prisma as never, sources);
  marks.onModuleInit();
  return { marks, sources, calls };
}

describe("PaymentCheckoutMarks: строка хронологии", () => {
  it("проверка пройдена — строка вида checkout во время проверки, без имени актёра", async () => {
    const { sources } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: null });

    expect(await sources.timeline(purchase())).toEqual([{ at: CHECKED_AT, kind: "checkout", text: "Предварительная проверка пройдена", actorName: null }]);
  });

  it("отказ — подпись причины после тире", async () => {
    const { sources } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: "price_mismatch" });

    expect(await sources.timeline(purchase())).toEqual([{ at: CHECKED_AT, kind: "checkout", text: "Предварительная проверка: отказ — сумма не совпала", actorName: null }]);
  });

  it("подписи всех одиннадцати отказов — дословно", async () => {
    const labels: Record<CheckoutRefusal, string> = {
      disabled: "оплата выключена",
      unknown_invoice: "счёт не найден",
      foreign_user: "платит другой игрок",
      purchases_closed: "покупки аккаунту закрыты",
      already_paid: "уже оплачено",
      subscription_active: "VIP уже действует",
      price_mismatch: "сумма не совпала",
      stale_invoice: "счёт устарел",
      run_finished: "забег закончен",
      continue_taken: "продолжено за рекламу",
      unavailable: "база не ответила",
    };

    for (const [reason, label] of Object.entries(labels)) {
      const { sources } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: reason });
      const lines = await sources.timeline(purchase());
      expect(lines.map((line) => line.text), reason).toEqual([`Предварительная проверка: отказ — ${label}`]);
    }
  });

  it("незнакомый код отказа показывается как есть, а не прячет проверку", async () => {
    const { sources } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: "weird" });

    expect((await sources.timeline(purchase())).map((line) => line.text)).toEqual(["Предварительная проверка: отказ — weird"]);
  });

  it("проверки не было — в хронологии пусто", async () => {
    const { sources } = build({ checkoutAt: null, checkoutRefusal: null });

    expect(await sources.timeline(purchase())).toEqual([]);
  });

  it("покупки нет в базе — в хронологии пусто", async () => {
    const { sources } = build(null);

    expect(await sources.timeline(purchase())).toEqual([]);
  });

  it("читает отметку по номеру покупки карточки и только две её колонки", async () => {
    const { sources, calls } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: null });

    await sources.timeline(purchase());

    expect(calls.find).toEqual([{ where: { purchaseId: PURCHASE_ID }, select: { checkoutAt: true, checkoutRefusal: true } }]);
  });

  it("пометок ленты и действий у источника нет", async () => {
    const { sources } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: "stale_invoice" });

    expect(await sources.marks([PURCHASE_ID])).toEqual(new Map());
    expect(await sources.actions(purchase())).toEqual([]);
  });

  it("перерегистрация источника не удваивает строку", async () => {
    const { marks, sources } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: null });
    marks.onModuleInit();

    expect(await sources.timeline(purchase())).toHaveLength(1);
  });
});

describe("PaymentCheckoutMarks.of: разбор строки базы", () => {
  it("отдаёт время и отказ последней проверки", async () => {
    const { marks } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: "run_finished" });

    expect(await marks.of(PURCHASE_ID)).toEqual({ at: CHECKED_AT, refusal: "run_finished" });
  });

  it("пройденная проверка — отказ `null`", async () => {
    const { marks } = build({ checkoutAt: CHECKED_AT, checkoutRefusal: null });

    expect(await marks.of(PURCHASE_ID)).toEqual({ at: CHECKED_AT, refusal: null });
  });

  it("проверки не было или покупки нет — `null`", async () => {
    expect(await build({ checkoutAt: null, checkoutRefusal: null }).marks.of(PURCHASE_ID)).toBeNull();
    expect(await build(null).marks.of(PURCHASE_ID)).toBeNull();
  });

  it("отказ без времени — проверки нет: показать нечего", async () => {
    expect(await build({ checkoutAt: null, checkoutRefusal: "stale_invoice" }).marks.of(PURCHASE_ID)).toBeNull();
  });
});

describe("PaymentCheckoutMarks.mark: запись в базу", () => {
  it("пишет время и отказ по номеру покупки, не роняя запись, которой нет", async () => {
    const { marks, calls } = build(null);

    await marks.mark(PURCHASE_ID, CHECKED_AT, "stale_invoice");

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ where: { purchaseId: PURCHASE_ID }, data: { checkoutAt: CHECKED_AT, checkoutRefusal: "stale_invoice" } });
  });

  it("пройденная проверка стирает прежний отказ: пишется `null`", async () => {
    const { marks, calls } = build(null);

    await marks.mark(randomUUID(), CHECKED_AT, null);

    expect(calls.update[0]).toMatchObject({ data: { checkoutAt: CHECKED_AT, checkoutRefusal: null } });
  });
});
