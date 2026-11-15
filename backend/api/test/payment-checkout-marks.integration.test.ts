import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PaymentCheckoutMarks } from "../src/modules/payments/payment-checkout-marks.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import { testPrisma } from "./helpers/test-prisma.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Отметка предварительной проверки на настоящем Postgres (tasks/T-0430,
 * docs/17-testing-strategy.md §4.2). Адрес — TEST_DATABASE_URL; без него
 * пропускается.
 *
 * Память этого не покажет: что запись по несуществующей покупке не падает, что
 * время хранится с точностью до миллисекунды и что опоздавшая запись не
 * перетирает более свежую.
 *
 * Все покупки теста лежат в окне января 2032 года: настоящие тесты и прежние
 * прогоны в то же окно не попадают.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const WINDOW = { from: new Date(Date.UTC(2032, 0, 1)), to: new Date(Date.UTC(2032, 1, 1)) };
const at = (minutes: number): Date => new Date(Date.UTC(2032, 0, 10, 10, minutes));

describe.skipIf(DATABASE_URL === "")("отметка предварительной проверки на живом Postgres", () => {
  let prisma: PrismaClient;
  let marks: PaymentCheckoutMarks;
  let accountId = "";

  async function wipeWindow(): Promise<void> {
    await prisma.purchase.deleteMany({ where: { invoicedAt: { gte: WINDOW.from, lt: WINDOW.to } } });
  }

  /** Новая покупка товара магазина со счётом в окне теста. */
  async function newPurchase(): Promise<string> {
    const purchaseId = randomUUID();
    await prisma.purchase.create({
      data: { purchaseId, accountId, product: "shop_item", sku: "starter_pack", priceStars: 50, chargedStars: 50, mode: "live", status: "pending", invoicedAt: at(0) },
    });
    return purchaseId;
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 4);
    const accounts = new PrismaAccountRepository(prisma);
    const arrival = { platform: "telegram" as const, platformUserId: uniquePlatformUserId(), displayName: "Стрелок", username: null, photoUrl: null };
    accountId = (await accounts.upsert(arrival, Date.now())).accountId;
    await wipeWindow();
    marks = new PaymentCheckoutMarks(prisma, new PaymentFeedSources());
  });

  afterAll(async () => {
    await wipeWindow();
    await prisma.$disconnect();
  });

  it("у покупки без проверки отметки нет", async () => {
    expect(await marks.of(await newPurchase())).toBeNull();
  });

  it("записанная проверка читается обратно — и отказом, и без него", async () => {
    const purchaseId = await newPurchase();

    await marks.mark(purchaseId, at(5), "stale_invoice");
    expect(await marks.of(purchaseId)).toEqual({ at: at(5), refusal: "stale_invoice" });

    await marks.mark(purchaseId, at(6), null);
    expect(await marks.of(purchaseId)).toEqual({ at: at(6), refusal: null });
  });

  it("две проверки подряд — читается последняя, прежний отказ стёрт", async () => {
    const purchaseId = await newPurchase();

    await marks.mark(purchaseId, at(5), "price_mismatch");
    await marks.mark(purchaseId, at(7), null);

    expect(await marks.of(purchaseId)).toEqual({ at: at(7), refusal: null });
  });

  it("опоздавшая запись старой проверки не перетирает более свежую", async () => {
    const purchaseId = await newPurchase();

    await marks.mark(purchaseId, at(9), "stale_invoice");
    await marks.mark(purchaseId, at(8), null);

    expect(await marks.of(purchaseId)).toEqual({ at: at(9), refusal: "stale_invoice" });
  });

  it("запись по несуществующей покупке — без ошибки, ничего не создаёт", async () => {
    const missing = randomUUID();

    await expect(marks.mark(missing, at(5), "unknown_invoice")).resolves.toBeUndefined();

    expect(await marks.of(missing)).toBeNull();
    expect(await prisma.purchase.count({ where: { purchaseId: missing } })).toBe(0);
  });

  it("отметка не трогает остальные колонки покупки", async () => {
    const purchaseId = await newPurchase();
    const before = await prisma.purchase.findUniqueOrThrow({ where: { purchaseId } });

    await marks.mark(purchaseId, at(5), null);

    const after = await prisma.purchase.findUniqueOrThrow({ where: { purchaseId } });
    expect({ ...after, checkoutAt: null, checkoutRefusal: null }).toEqual({ ...before, checkoutAt: null, checkoutRefusal: null });
  });

  it("строка хронологии из живой базы — по отметке покупки", async () => {
    const sources = new PaymentFeedSources();
    new PaymentCheckoutMarks(prisma, sources).onModuleInit();
    const purchaseId = await newPurchase();
    await marks.mark(purchaseId, at(5), "price_mismatch");
    const stored = await prisma.purchase.findUniqueOrThrow({ where: { purchaseId } });

    const lines = await sources.timeline(stored);

    expect(lines).toEqual([{ at: at(5), kind: "checkout", text: "Предварительная проверка: отказ — сумма не совпала", actorName: null }]);
  });
});
