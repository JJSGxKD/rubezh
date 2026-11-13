import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { LedgerSyncPass } from "../src/modules/ledger/ledger-sync.job.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { paymentSourceKey } from "../src/modules/ledger/payment-postings.js";
import { PrismaPaymentPostingsRepository } from "../src/modules/ledger/payment-postings.repository.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Проводки из платежей на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без
 * него пропуск; Р219, tasks/T-0458): задание сверки читает `purchase` настоящими запросами и пишет в журнал
 * через настоящий `LedgerService`. Остатки, повторный проход, два прохода разом и догон 1 200 оплат.
 *
 * Журнал не стирается — триггер этого не позволит, — поэтому тест ничего из него не убирает: покупки и
 * аккаунты тестовые, с уникальными id, а проверяются только проводки этих покупок по ключам источника. В общей
 * базе параллельно пишут и другие файлы, их живые оплаты проход тоже проведёт — на выводах теста это не
 * сказывается: считаются только свои покупки. Дата «сейчас» у прохода — подменённая, в начале 2000-х: оплаты
 * соседей к ней ещё не доросли и выхода из холда не получают.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const DAY_MS = 86_400_000;

type Product = "shop_item" | "continue_run" | "vip" | "donation";

interface Bought {
  purchaseId: string;
  stars: number;
  product: Product;
  paidAt: Date;
  refundedAt?: Date;
}

describe.skipIf(DATABASE_URL === "")("проводки из платежей на живом Postgres", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let telegramAccount = "";
  let maxAccount = "";
  const mine: string[] = [];

  function newPass(): LedgerSyncPass {
    return new LedgerSyncPass(new PrismaPaymentPostingsRepository(prisma), ledger, panelSettings());
  }

  async function createAccount(platform: "telegram" | "max"): Promise<string> {
    const accountId = randomUUID();
    await prisma.account.create({ data: { accountId, platform, platformUserId: `pp-${accountId.slice(0, 12)}`, displayName: "Покупатель проводок" } });
    return accountId;
  }

  function row(accountId: string, bought: Bought) {
    return {
      purchaseId: bought.purchaseId,
      accountId,
      product: bought.product,
      sku: bought.product === "donation" ? "donation" : `pp-${bought.purchaseId.slice(0, 8)}`,
      priceStars: bought.stars,
      chargedStars: bought.stars,
      mode: "live" as const,
      status: bought.refundedAt === undefined ? ("paid" as const) : ("refunded" as const),
      invoicedAt: bought.paidAt,
      paidAt: bought.paidAt,
      ...(bought.refundedAt === undefined ? {} : { refundedAt: bought.refundedAt }),
    };
  }

  async function buy(accountId: string, patch: Omit<Bought, "purchaseId">): Promise<Bought> {
    const bought: Bought = { purchaseId: randomUUID(), ...patch };
    await prisma.purchase.create({ data: row(accountId, bought) });
    mine.push(bought.purchaseId);
    return bought;
  }

  /** Суммы строк по счетам для проводок этих покупок: что проход записал в журнал. */
  async function sums(purchases: readonly Bought[]): Promise<Record<string, bigint>> {
    const keys = purchases.flatMap((p) => (["paid", "release", "refund"] as const).map((kind) => paymentSourceKey(p.purchaseId, kind)));
    const lines = await prisma.ledgerLine.groupBy({ by: ["accountId"], _sum: { amount: true }, where: { entry: { sourceKey: { in: keys } } } });
    const entries = lines.map((line) => [line.accountId, line._sum.amount ?? 0n] as const);
    return Object.fromEntries(entries.filter(([, amount]) => amount !== 0n));
  }

  async function entryCount(purchases: readonly Bought[]): Promise<number> {
    const keys = purchases.flatMap((p) => (["paid", "release", "refund"] as const).map((kind) => paymentSourceKey(p.purchaseId, kind)));
    return await prisma.ledgerEntry.count({ where: { sourceKey: { in: keys } } });
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    telegramAccount = await createAccount("telegram");
    maxAccount = await createAccount("max");
  });

  afterAll(async () => {
    // Покупки и аккаунты теста — обычные таблицы, их убрать можно; проводки журнала остаются навсегда.
    await prisma.purchase.deleteMany({ where: { purchaseId: { in: mine } } });
    await prisma.account.deleteMany({ where: { accountId: { in: [telegramAccount, maxAccount] } } });
    await prisma.$disconnect();
  });

  it("четыре оплаты: остатки холда, доступного и выручки по статьям точны; сторно до срока и возврат после срока", async () => {
    const paidDay = (iso: string) => new Date(iso);
    // 1 ноября 2001: оплата, потом выход 22 ноября
    const plain = await buy(telegramAccount, { stars: 50, product: "shop_item", paidAt: paidDay("2001-11-01T12:00:00Z") });
    // возврат до срока: выхода из холда не будет
    const early = await buy(telegramAccount, { stars: 30, product: "continue_run", paidAt: paidDay("2001-11-02T12:00:00Z"), refundedAt: paidDay("2001-11-10T09:00:00Z") });
    // возврат после срока: выход проведён, потом возврат из доступного
    const late = await buy(telegramAccount, { stars: 20, product: "vip", paidAt: paidDay("2001-11-03T12:00:00Z"), refundedAt: paidDay("2001-11-30T09:00:00Z") });
    // донат оплачен 10 декабря: 15 декабря он ещё в холде
    const donation = await buy(telegramAccount, { stars: 100, product: "donation", paidAt: paidDay("2001-12-10T12:00:00Z") });
    const all = [plain, early, late, donation];

    const pass = newPass();
    pass.clock = () => new Date("2001-12-15T00:10:00Z");
    await pass.run();

    // «в холде» — только донат; «доступно» — только первая оплата; выручка — первая и донат, остальное возвращено.
    expect(await sums(all)).toEqual({
      "stars.bot.hold": 100n,
      "stars.bot.available": 50n,
      "revenue.shop.telegram": -50n,
      "revenue.donation.telegram": -100n,
    });
    expect(await entryCount(all)).toBe(2 + 2 + 3 + 1);

    // Остаток «доступно» плюс «в холде» — сумма оплат без возвратов.
    const totals = await sums(all);
    expect((totals["stars.bot.hold"] ?? 0n) + (totals["stars.bot.available"] ?? 0n)).toBe(BigInt(plain.stars + donation.stars));

    // Сторно до срока ссылается на оплату и стоит на дату возврата; возврат после срока — не сторно.
    const earlyPaid = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: paymentSourceKey(early.purchaseId, "paid") } });
    const earlyRefund = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: paymentSourceKey(early.purchaseId, "refund") } });
    expect(earlyRefund.reversalOf).toBe(earlyPaid.entryId);
    expect(earlyRefund.at).toEqual(early.refundedAt);
    expect(await prisma.ledgerEntry.findUnique({ where: { sourceKey: paymentSourceKey(early.purchaseId, "release") } })).toBeNull();
    const lateRefund = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: paymentSourceKey(late.purchaseId, "refund") } });
    expect(lateRefund.reversalOf).toBeNull();

    // Срок выхода записан в проводку оплаты: 1 ноября + 21 день.
    const paid = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: paymentSourceKey(plain.purchaseId, "paid") } });
    expect(paid.meta).toMatchObject({ purchaseId: plain.purchaseId, product: "shop_item", releaseAt: "2001-11-22T12:00:00.000Z" });
    expect(paid.at).toEqual(plain.paidAt);

    // Второй проход ничего не создаёт.
    await newPassAt("2001-12-15T00:10:00Z").run();
    expect(await entryCount(all)).toBe(8);
    expect(await sums(all)).toEqual(totals);

    // Донат выходит из холда 31 декабря: проход 5 января проводит выход на дату срока.
    await newPassAt("2002-01-05T00:10:00Z").run();
    expect(await entryCount(all)).toBe(9);
    expect(await sums(all)).toEqual({ "stars.bot.available": 150n, "revenue.shop.telegram": -50n, "revenue.donation.telegram": -100n });
    const donationRelease = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: paymentSourceKey(donation.purchaseId, "release") } });
    expect(donationRelease.at).toEqual(new Date("2001-12-31T12:00:00.000Z"));
  });

  function newPassAt(iso: string): LedgerSyncPass {
    const pass = newPass();
    pass.clock = () => new Date(iso);
    return pass;
  }

  it("оплата с другой площадки и тестовая в журнал не попадают, проход идёт дальше", async () => {
    const foreign = await buy(maxAccount, { stars: 70, product: "shop_item", paidAt: new Date("2002-02-01T12:00:00Z") });
    const ordinary = await buy(telegramAccount, { stars: 10, product: "shop_item", paidAt: new Date("2002-02-02T12:00:00Z") });
    const test = randomUUID();
    await prisma.purchase.create({ data: { ...row(telegramAccount, { purchaseId: test, stars: 1, product: "shop_item", paidAt: new Date("2002-02-03T12:00:00Z") }), mode: "test" } });
    mine.push(test);

    const result = await newPassAt("2002-02-10T00:00:00Z").run();

    expect(result.unsupported).toBeGreaterThanOrEqual(1);
    expect(await entryCount([foreign])).toBe(0);
    expect(await entryCount([{ ...foreign, purchaseId: test }])).toBe(0);
    expect(await entryCount([ordinary])).toBe(1);
  });

  it("два прохода одновременно — проводок не больше, чем нужно", async () => {
    const batch: Bought[] = [];
    for (let i = 0; i < 6; i += 1) {
      batch.push(
        await buy(telegramAccount, {
          stars: 10 + i,
          product: "shop_item",
          paidAt: new Date(Date.UTC(2003, 0, 1, 12, i)),
          ...(i % 3 === 0 ? { refundedAt: new Date(Date.UTC(2003, 0, 5, 12, i)) } : i % 3 === 1 ? { refundedAt: new Date(Date.UTC(2003, 1, 20, 12, i)) } : {}),
        }),
      );
    }
    // Ожидание: i=0,3 — оплата и сторно (2 проводки); i=1,4 — оплата, выход, возврат (3); i=2,5 — оплата и выход (2).
    const expected = 2 * 2 + 2 * 3 + 2 * 2;

    await Promise.all([newPassAt("2003-03-01T00:00:00Z").run(), newPassAt("2003-03-01T00:00:00Z").run(), newPassAt("2003-03-01T00:00:00Z").run()]);

    expect(await entryCount(batch)).toBe(expected);
    // Каждая проводка — ровно одна и сбалансирована: по две строки в нужной валюте.
    const lines = await prisma.ledgerLine.count({ where: { entry: { sourceKey: { in: batch.flatMap((p) => (["paid", "release", "refund"] as const).map((kind) => paymentSourceKey(p.purchaseId, kind))) } } } });
    expect(lines).toBe(expected * 2);
    // Итог по всем: возвраты погасили своё, остались оплаты без возвратов (i=2: 12, i=5: 15) уже в «доступно».
    expect(await sums(batch)).toEqual({ "stars.bot.available": 27n, "revenue.shop.telegram": -27n });
  });

  it("1 200 оплат догоняются за несколько проходов подряд без пропусков", { timeout: 300_000 }, async () => {
    const batch: Bought[] = Array.from({ length: 1_200 }, (_, i) => ({
      purchaseId: randomUUID(),
      stars: 10,
      product: "shop_item" as const,
      paidAt: new Date(Date.UTC(2004, 0, 1, 0, 0, 0) + i * 60_000),
    }));
    await prisma.purchase.createMany({ data: batch.map((bought) => row(telegramAccount, bought)) });
    mine.push(...batch.map((bought) => bought.purchaseId));

    // Каждый проход — один круг на пятьсот оплат: догоняем прошлое проходами подряд, как после выката.
    let passes = 0;
    let drained = false;
    while (!drained && passes < 10) {
      const pass = newPassAt("2004-06-01T00:00:00Z");
      pass.maxRounds = 1;
      drained = (await pass.run()).drained;
      passes += 1;
    }

    expect(drained).toBe(true);
    expect(passes).toBeGreaterThanOrEqual(3);
    expect(passes).toBeLessThanOrEqual(4);
    // Ни одной пропущенной: у каждой оплаты есть и «оплата», и «выход».
    expect(await entryCount(batch)).toBe(2_400);
    expect(await sums(batch)).toEqual({ "stars.bot.available": 12_000n, "revenue.shop.telegram": -12_000n });

    // И следующий проход, и ещё один — ничего не меняют.
    await newPassAt("2004-06-01T00:00:00Z").run();
    expect(await entryCount(batch)).toBe(2_400);
  });
});
