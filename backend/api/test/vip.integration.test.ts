import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { PrismaVipRepository } from "../src/modules/vip/vip.repository.js";

/**
 * VIP на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): периоды выстраиваются в цепочку и под
 * гонкой, повтор выдачи — тот же период; отменённое остаётся за тем, кто
 * отменил первым, а оплата продления не перебивает отмену, записанную позже
 * неё; самоцветы — раз в московские сутки.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 8, 30, 9));
const PERIOD_SEC = 30 * 24 * 3600;
const DAY_MS = 86_400_000;

describe.skipIf(DATABASE_URL === "")("VIP на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let purchases: PrismaPurchasesRepository;
  let vip: PrismaVipRepository;

  async function account(): Promise<string> {
    const platformUserId = String(970_000_000 + Math.floor(Math.random() * 20_000_000));
    return (await accounts.upsert({ platform: "telegram", platformUserId, displayName: "VIP", username: null }, Date.now())).accountId;
  }

  /** Оплаченная покупка VIP — строка, на которую ссылается период. */
  async function paidVip(accountId: string, renewalOf: string | null = null): Promise<string> {
    const purchaseId = randomUUID();
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "vip",
        sku: "vip_month",
        priceStars: 200,
        chargedStars: 200,
        mode: "live",
        status: "paid",
        telegramChargeId: `charge-${purchaseId}`,
        invoicedAt: NOW,
        paidAt: NOW,
        renewalOf,
      },
    });
    return purchaseId;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    purchases = new PrismaPurchasesRepository(prisma);
    vip = new PrismaVipRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("без VIP — пустое состояние; сутки — по Москве", async () => {
    const me = await account();
    const lateUtc = new Date(Date.UTC(2026, 8, 30, 22));
    expect(await vip.state(me, lateUtc)).toEqual({ until: null, subscriptions: [], today: "2026-10-01", dailyClaimedToday: false });
  });

  it("первый период — с оплаты; продления — с конца прежнего даже под гонкой; повтор выдачи — тот же период", async () => {
    const me = await account();
    const first = await paidVip(me);
    const record = (purchaseId: string) => ({ purchaseId, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });

    const started = await vip.addPeriod(record(first));
    expect(started).toEqual({ startsAt: NOW, endsAt: new Date(NOW.getTime() + 30 * DAY_MS), created: true });
    expect(await vip.addPeriod(record(first))).toEqual({ ...started, created: false });

    const renewals = await Promise.all([paidVip(me, first), paidVip(me, first), paidVip(me, first)]);
    const periods = await Promise.all([...renewals, renewals[0] ?? ""].map((id) => vip.addPeriod(record(id))));
    expect(periods.filter((period) => period.created)).toHaveLength(3);
    const ends = periods.filter((period) => period.created).map((period) => period.endsAt.getTime()).sort((a, b) => a - b);
    expect(ends).toEqual([60, 90, 120].map((days) => NOW.getTime() + days * DAY_MS));

    const state = await vip.state(me, NOW);
    expect(state.until).toEqual(new Date(NOW.getTime() + 120 * DAY_MS));
    expect(state.subscriptions).toEqual([{ subscriptionId: first, renewal: "on", cancelledBy: null, createdAt: NOW, until: state.until }]);
  });

  it("кончившийся VIP начинается заново с оплаты, а не с прошлого конца", async () => {
    const me = await account();
    const first = await paidVip(me);
    await vip.addPeriod({ purchaseId: first, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });
    const later = new Date(NOW.getTime() + 90 * DAY_MS);
    const again = await paidVip(me);
    expect(await vip.addPeriod({ purchaseId: again, subscriptionId: again, accountId: me, paidAt: later, periodSec: PERIOD_SEC, at: later })).toMatchObject({ startsAt: later });
    expect((await vip.state(me, later)).subscriptions.map((item) => item.subscriptionId)).toEqual([again, first]);
  });

  it("отменённое — за тем, кто отменил первым; оплата продления не перебивает отмену, записанную позже неё", async () => {
    const me = await account();
    const first = await paidVip(me);
    expect(await vip.setRenewal(first, "cancelled", "player", NOW)).toBe("missing");
    await vip.addPeriod({ purchaseId: first, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });

    const cancelledAt = new Date(NOW.getTime() + 30 * DAY_MS + 60_000);
    expect(await vip.setRenewal(first, "cancelled", "game", cancelledAt)).toBe("updated");
    expect(await vip.setRenewal(first, "cancelled", "player", cancelledAt)).toBe("unchanged");

    // Продление списано до отмены, а выдано после неё — отмена остаётся.
    const renewal = await paidVip(me, first);
    const paidBefore = new Date(NOW.getTime() + 30 * DAY_MS);
    await vip.addPeriod({ purchaseId: renewal, subscriptionId: first, accountId: me, paidAt: paidBefore, periodSec: PERIOD_SEC, at: new Date(cancelledAt.getTime() + 60_000) });
    expect((await vip.state(me, NOW)).subscriptions[0]).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });

    // Продление, списанное после отмены, — игрок вернул его сам: снова `on`.
    const next = await paidVip(me, first);
    const paidAfter = new Date(cancelledAt.getTime() + 30 * DAY_MS);
    await vip.addPeriod({ purchaseId: next, subscriptionId: first, accountId: me, paidAt: paidAfter, periodSec: PERIOD_SEC, at: paidAfter });
    expect((await vip.state(me, NOW)).subscriptions[0]).toMatchObject({ renewal: "on", cancelledBy: null });
  });

  it("база не примет отмену без автора и пустой период", async () => {
    const me = await account();
    const first = await paidVip(me);
    await vip.addPeriod({ purchaseId: first, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });
    await expect(prisma.$executeRaw`UPDATE vip_subscription SET renewal = 'cancelled' WHERE subscription_id = ${first}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE vip_period SET ends_at = starts_at WHERE purchase_id = ${first}::uuid`).rejects.toThrow();
  });

  it("самоцветы — раз в московские сутки и под гонкой", async () => {
    const me = await account();
    const results = await Promise.all(Array.from({ length: 4 }, () => vip.claimDaily(me, "2026-09-30", NOW)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await vip.state(me, NOW)).dailyClaimedToday).toBe(true);
    expect(await vip.claimDaily(me, "2026-09-29", NOW)).toBe(false);
    expect(await vip.claimDaily(me, "2026-10-01", NOW)).toBe(true);
  });

  it("покупка VIP в журнале покупок — продления видны своей строкой", async () => {
    const me = await account();
    const first = await paidVip(me);
    await paidVip(me, first);
    expect((await purchases.byAccount(me, 10)).map((row) => row.renewalOf).sort()).toEqual([first, null].sort());
  });
});
