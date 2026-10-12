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

    const at = new Date();
    await expect(purchases.checkout(opened.purchase.purchaseId, at)).resolves.toMatchObject({ platformUserId: account.platformUserId, runFinished: false, subscriptionLive: false });
    await prisma.run.update({ where: { runId }, data: { status: "finished" } });
    await expect(purchases.checkout(opened.purchase.purchaseId, at)).resolves.toMatchObject({ runFinished: true });
    await expect(purchases.checkout(randomUUID(), at)).resolves.toBeNull();
  });

  describe("идёт ли у владельца VIP с продлением (T-0025)", () => {
    const DAY_MS = 86_400_000;

    async function owner(): Promise<string> {
      const account = await accounts.upsert(
        { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Подписчик", username: null, photoUrl: null },
        Date.now(),
      );
      return account.accountId;
    }

    /** Оплаченная подписка: покупка, подписка с продлением и один период, как их оставляет выдача. */
    async function subscribed(accountId: string, endsAt: Date, renewal: "on" | "cancelled" | "failed"): Promise<string> {
      const purchaseId = randomUUID();
      const paidAt = new Date(endsAt.getTime() - 30 * DAY_MS);
      await prisma.purchase.create({
        data: {
          purchaseId,
          accountId,
          product: "vip",
          sku: "vip",
          priceStars: 700,
          chargedStars: 700,
          mode: "live",
          status: "paid",
          telegramChargeId: `charge-${randomUUID()}`,
          invoicedAt: paidAt,
          paidAt,
        },
      });
      // База требует, чтобы у отменённого продления был тот, кто его отменил.
      const cancelledBy = renewal === "cancelled" ? "player" : null;
      await prisma.vipSubscription.create({ data: { subscriptionId: purchaseId, accountId, renewal, cancelledBy, createdAt: paidAt, updatedAt: paidAt } });
      await prisma.vipPeriod.create({ data: { purchaseId, subscriptionId: purchaseId, accountId, startsAt: paidAt, endsAt, createdAt: paidAt } });
      return purchaseId;
    }

    /** Новый счёт на VIP — тот, чью оплату проверяет Telegram. */
    async function newInvoice(accountId: string): Promise<string> {
      const opened = await purchases.openShopInvoice({
        purchaseId: randomUUID(),
        accountId,
        product: "vip",
        sku: "vip",
        onceKey: null,
        priceStars: 700,
        chargedStars: 700,
        mode: "live",
        invoicedAt: new Date(),
      });
      if (opened.kind !== "opened") throw new Error("счёт не открылся");
      return opened.purchase.purchaseId;
    }

    it("период ещё идёт и продление включено — подписка живая", async () => {
      const accountId = await owner();
      const at = new Date();
      await subscribed(accountId, new Date(at.getTime() + 10 * DAY_MS), "on");

      const view = await purchases.checkout(await newInvoice(accountId), at);

      expect(view).toMatchObject({ subscriptionLive: true });
    });

    it("период кончился — подписка не живая, даже с включённым продлением", async () => {
      const accountId = await owner();
      const at = new Date();
      await subscribed(accountId, new Date(at.getTime() - 1000), "on");

      await expect(purchases.checkout(await newInvoice(accountId), at)).resolves.toMatchObject({ subscriptionLive: false });
    });

    it("граница: период, кончающийся ровно в момент проверки, уже не идёт", async () => {
      const accountId = await owner();
      const at = new Date();
      await subscribed(accountId, at, "on");

      await expect(purchases.checkout(await newInvoice(accountId), at)).resolves.toMatchObject({ subscriptionLive: false });
    });

    it.each(["cancelled", "failed"] as const)("продление `%s` — подписка не живая: списывать нечего", async (renewal) => {
      const accountId = await owner();
      const at = new Date();
      await subscribed(accountId, new Date(at.getTime() + 10 * DAY_MS), renewal);

      await expect(purchases.checkout(await newInvoice(accountId), at)).resolves.toMatchObject({ subscriptionLive: false });
    });

    it("VIP не было вовсе — подписка не живая", async () => {
      const accountId = await owner();

      await expect(purchases.checkout(await newInvoice(accountId), new Date())).resolves.toMatchObject({ subscriptionLive: false });
    });

    it("условия на уровне аккаунта, а не подписки: идущий период одной и включённое продление другой вместе дают живую", async () => {
      const accountId = await owner();
      const at = new Date();
      // Отменённая подписка ещё в оплаченном периоде, а у другой продление числится включённым: если оно настоящее, второй счёт удвоил бы списание.
      await subscribed(accountId, new Date(at.getTime() + 10 * DAY_MS), "cancelled");
      await subscribed(accountId, new Date(at.getTime() - DAY_MS), "on");

      await expect(purchases.checkout(await newInvoice(accountId), at)).resolves.toMatchObject({ subscriptionLive: true });
    });

    it("чужая подписка не считается", async () => {
      const other = await owner();
      const at = new Date();
      await subscribed(other, new Date(at.getTime() + 10 * DAY_MS), "on");
      const accountId = await owner();

      await expect(purchases.checkout(await newInvoice(accountId), at)).resolves.toMatchObject({ subscriptionLive: false });
    });
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

  it("заказ возврата: первая причина остаётся, незавершённый виден после перезапуска", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice(invoice(accountId, runId));
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    const { purchaseId } = opened.purchase;

    // Не оплачено — возвращать нечего.
    await expect(purchases.requestRefund(purchaseId, "unused", new Date())).resolves.toBeNull();

    const chargeId = `charge-${randomUUID()}`;
    await purchases.markPaid({ purchaseId, chargeId, chargedStars: 3, paidAt: new Date() });
    expect(await purchases.unusedGrants(runId, 0)).toEqual([purchaseId]);
    expect(await purchases.unusedGrants(runId, 1)).toEqual([]);

    const order = await purchases.requestRefund(purchaseId, "unused", new Date());
    await purchases.requestRefund(purchaseId, "test_mode", new Date());
    const account = await prisma.account.findUniqueOrThrow({ where: { accountId } });

    expect(order).toEqual({ purchaseId, platform: account.platform, chargeId, payerId: account.platformUserId, reason: "unused" });
    expect(await purchases.unusedGrants(runId, 0)).toEqual([]);
    expect((await purchases.pendingRefunds(500)).map((pending) => pending.purchaseId)).toContain(purchaseId);

    await purchases.markRefunded(chargeId, new Date());
    expect((await purchases.pendingRefunds(500)).map((pending) => pending.purchaseId)).not.toContain(purchaseId);
    await expect(purchases.requestRefund(purchaseId, "unused", new Date())).resolves.toBeNull();
  });

  it("довыдача: undelivered отдаёт только оплаченную, старую, не выданную и не возвращаемую покупку нужного товара", async () => {
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Покупатель", username: null, photoUrl: null },
      Date.now(),
    );
    const now = Date.now();
    const minutesAgo = (minutes: number): Date => new Date(now - minutes * 60_000);
    const row = (patch: Record<string, unknown> = {}) =>
      prisma.purchase.create({
        data: {
          purchaseId: randomUUID(),
          accountId: account.accountId,
          product: "shop_item",
          sku: "starter_pack",
          priceStars: 50,
          chargedStars: 50,
          mode: "live",
          status: "paid",
          telegramChargeId: `charge-${randomUUID()}`,
          invoicedAt: minutesAgo(200),
          paidAt: minutesAgo(120),
          ...patch,
        },
      });

    const eligible = await row();
    const olderEligible = await row({ paidAt: minutesAgo(180) });
    await row({ fulfilledAt: minutesAgo(100) });
    await row({ paidAt: minutesAgo(10) });
    await row({ refundReason: "unused", refundRequestedAt: minutesAgo(60) });
    await row({ status: "refunded", refundReason: "external", refundedAt: minutesAgo(60) });
    await row({ product: "vip", sku: "vip_month" });
    await row({ status: "pending", paidAt: null, telegramChargeId: null });

    const found = await purchases.undelivered(["shop_item"], minutesAgo(45), 500);
    const ours = found.filter((purchase) => purchase.accountId === account.accountId).map((purchase) => purchase.purchaseId);

    // Старые первыми; выданная, свежая, возвращаемая, чужого товара и неоплаченная — не отданы.
    expect(ours).toEqual([olderEligible.purchaseId, eligible.purchaseId]);
    expect((await purchases.undelivered(["shop_item", "vip"], minutesAgo(45), 500)).filter((purchase) => purchase.accountId === account.accountId)).toHaveLength(3);
    expect(await purchases.undelivered([], minutesAgo(45), 500)).toEqual([]);
  });

  it("аккаунт с покупками не удаляется вместе с деньгами", async () => {
    const { accountId, runId } = await startedRun();
    await purchases.openInvoice(invoice(accountId, runId));

    await expect(prisma.account.delete({ where: { accountId } })).rejects.toThrow();
    expect(await prisma.purchase.count({ where: { accountId } })).toBe(1);
  });
});
