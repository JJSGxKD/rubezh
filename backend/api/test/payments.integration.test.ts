import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaPurchasesRepository, type InvoiceRecord } from "../src/modules/payments/purchases.repository.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";

/**
 * Покупки на настоящем Postgres (docs/17-testing-strategy.md §4.2). Адрес —
 * TEST_DATABASE_URL; без него пропускается.
 *
 * Память этого не покажет: два одновременных счёта на одно продолжение
 * упираются в уникальный индекс базы, два одновременных подтверждения одной
 * оплаты — в уникальный идентификатор оплаты, а удалить аккаунт, за которым
 * числятся деньги, не даёт внешний ключ.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("покупки на живом Postgres", () => {
  let prisma: PrismaClient;
  let purchases: PrismaPurchasesRepository;
  let runs: PrismaRunsRepository;
  let accounts: PrismaAccountRepository;

  async function startedRun(): Promise<{ accountId: string; runId: string }> {
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(800_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Стрелок", username: null, photoUrl: null },
      Date.now(),
    );
    const runId = randomUUID();
    await runs.start({ runId, accountId: account.accountId, difficulty: "normal", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
    return { accountId: account.accountId, runId };
  }

  function invoice(accountId: string, runId: string, patch: Partial<InvoiceRecord> = {}): InvoiceRecord {
    return {
      purchaseId: randomUUID(),
      accountId,
      runId,
      continueNo: 1,
      elapsedSec: 125,
      priceStars: 3,
      chargedStars: 3,
      mode: "live",
      invoicedAt: new Date(),
      ...patch,
    };
  }

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    purchases = new PrismaPurchasesRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("одновременные счета на одно продолжение — одна покупка", async () => {
    const { accountId, runId } = await startedRun();

    const outcomes = await Promise.all(Array.from({ length: 5 }, () => purchases.openInvoice(invoice(accountId, runId))));

    const ids = new Set(outcomes.map((outcome) => (outcome.kind === "foreign" ? null : outcome.purchase.purchaseId)));
    expect(ids.size).toBe(1);
    expect(await prisma.purchase.count({ where: { runId } })).toBe(1);
  });

  it("повторный счёт обновляет цену неоплаченной покупки, а оплаченную не трогает", async () => {
    const { accountId, runId } = await startedRun();
    const first = await purchases.openInvoice(invoice(accountId, runId));
    if (first.kind !== "opened") throw new Error("счёт не открылся");

    const repriced = await purchases.openInvoice(invoice(accountId, runId, { elapsedSec: 190, priceStars: 4, chargedStars: 4 }));
    expect(repriced).toMatchObject({ kind: "opened", purchase: { purchaseId: first.purchase.purchaseId, priceStars: 4 } });

    await prisma.purchase.update({ where: { purchaseId: first.purchase.purchaseId }, data: { status: "paid", paidAt: new Date(), telegramChargeId: randomUUID() } });
    const paid = await purchases.openInvoice(invoice(accountId, runId, { elapsedSec: 300, priceStars: 5, chargedStars: 5 }));

    expect(paid).toMatchObject({ kind: "paid", purchase: { priceStars: 4 } });
    expect(await purchases.grantedContinues(runId)).toBe(1);
  });

  it("счёт к чужому забегу не открывается", async () => {
    const owner = await startedRun();
    const stranger = await startedRun();
    await purchases.openInvoice(invoice(owner.accountId, owner.runId));

    await expect(purchases.openInvoice(invoice(stranger.accountId, owner.runId))).resolves.toEqual({ kind: "foreign" });
  });

  it("одновременные подтверждения одной оплаты — одна запись", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice(invoice(accountId, runId));
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    const chargeId = `charge-${randomUUID()}`;
    const record = { purchaseId: opened.purchase.purchaseId, chargeId, chargedStars: 3, paidAt: new Date() };

    const outcomes = await Promise.all(Array.from({ length: 4 }, () => purchases.markPaid(record)));

    expect(outcomes.filter((outcome) => outcome.kind === "paid")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "duplicate")).toHaveLength(3);
  });

  it("вторая оплата той же покупки не перезаписывает первую", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice(invoice(accountId, runId));
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    const { purchaseId } = opened.purchase;

    const [first, second] = await Promise.all([
      purchases.markPaid({ purchaseId, chargeId: `charge-${randomUUID()}`, chargedStars: 3, paidAt: new Date() }),
      purchases.markPaid({ purchaseId, chargeId: `charge-${randomUUID()}`, chargedStars: 3, paidAt: new Date() }),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["already_paid", "paid"]);
    expect(await purchases.grantedContinues(runId)).toBe(1);
  });

  it("проверка оплаты видит владельца и закрытый забег одним запросом", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice(invoice(accountId, runId));
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    const account = await prisma.account.findUniqueOrThrow({ where: { accountId } });

    await expect(purchases.checkout(opened.purchase.purchaseId)).resolves.toMatchObject({ platformUserId: account.platformUserId, runFinished: false });
    await prisma.run.update({ where: { runId }, data: { status: "finished" } });
    await expect(purchases.checkout(opened.purchase.purchaseId)).resolves.toMatchObject({ runFinished: true });
    await expect(purchases.checkout(randomUUID())).resolves.toBeNull();
  });

  it("возврат записывается один раз и не стирает причину, заказанную нами", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice(invoice(accountId, runId));
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    const chargeId = `charge-${randomUUID()}`;
    await purchases.markPaid({ purchaseId: opened.purchase.purchaseId, chargeId, chargedStars: 3, paidAt: new Date() });
    await prisma.purchase.update({ where: { telegramChargeId: chargeId }, data: { refundReason: "unused", refundRequestedAt: new Date() } });

    const first = await purchases.markRefunded(chargeId, new Date(Date.now() + 1000));
    const repeat = await purchases.markRefunded(chargeId, new Date(Date.now() + 5000));

    expect(first).toMatchObject({ firstTime: true, purchase: { status: "refunded", refundReason: "unused" } });
    expect(repeat?.firstTime).toBe(false);
    expect(repeat?.purchase.refundedAt).toEqual(first?.purchase.refundedAt);
    await expect(purchases.refundStats(accountId)).resolves.toEqual({ paid: 1, refunded: 0 });
  });

  it("аккаунт с покупками не удаляется вместе с деньгами", async () => {
    const { accountId, runId } = await startedRun();
    await purchases.openInvoice(invoice(accountId, runId));

    await expect(prisma.account.delete({ where: { accountId } })).rejects.toThrow();
    expect(await prisma.purchase.count({ where: { accountId } })).toBe(1);
  });
});
