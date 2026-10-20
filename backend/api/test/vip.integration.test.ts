import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { SubscriptionRenewal } from "../src/modules/payments/subscription-renewal.js";
import { PrismaVipRepository, type PeriodRecord, type StoredPeriod, type VipState, type VipSubscriptionRow } from "../src/modules/vip/vip.repository.js";
import { VipService } from "../src/modules/vip/vip.service.js";
import { WalletBonuses } from "../src/modules/wallet/wallet-bonus.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { switchesOf } from "./helpers/notify-targets.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * VIP на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): периоды выстраиваются в цепочку и под
 * гонкой, повтор выдачи — тот же период; отменённое остаётся за тем, кто
 * отменил первым, а оплата продления не перебивает отмену, записанную позже
 * неё; самоцветы — раз в московские сутки; две подписки сразу не остаются
 * без продления обе (T-0140).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 8, 30, 9));
const PERIOD_SEC = 30 * 24 * 3600;
const DAY_MS = 86_400_000;

/**
 * Репозиторий VIP, в котором выдачи читают подписки только после того, как
 * обе записали период: каждая видит другую с продлением. Живая гонка даёт это
 * лишь иногда, а здесь — каждый раз.
 */
class CrossingVipRepository extends PrismaVipRepository {
  private written = 0;
  private release: () => void = () => undefined;
  private readonly allWritten = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(
    prisma: PrismaClient,
    private readonly writers: number,
  ) {
    super(prisma);
  }

  override async addPeriod(record: PeriodRecord): Promise<StoredPeriod> {
    const stored = await super.addPeriod(record);
    this.written += 1;
    if (this.written >= this.writers) this.release();
    return stored;
  }

  override async state(accountId: string, at: Date): Promise<VipState> {
    await this.allWritten;
    return await super.state(accountId, at);
  }
}

/** Подписка, у которой продление должно остаться: запись раньше, при равенстве времени — меньший идентификатор. */
function expectedWinner(subscriptions: readonly VipSubscriptionRow[]): string {
  const [winner] = [...subscriptions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.subscriptionId < b.subscriptionId ? -1 : 1));
  if (winner === undefined) throw new Error("подписок нет");
  return winner.subscriptionId;
}

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
    prisma = testPrisma(DATABASE_URL, 10);
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

  it("конец VIP для надбавки — самый поздний конец периода одним запросом; без VIP — пусто", async () => {
    const me = await account();
    expect(await vip.until(me)).toBeNull();
    const first = await paidVip(me);
    await vip.addPeriod({ purchaseId: first, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });
    await vip.addPeriod({ purchaseId: await paidVip(me, first), subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });
    expect(await vip.until(me)).toEqual(new Date(NOW.getTime() + 60 * DAY_MS));
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
  describe("неиспользованный остаток периода при возврате звёзд (T-0023)", () => {
    const MS = (days: number) => days * DAY_MS;

    /** Первая оплата подписки: период в 30 суток с `NOW`. */
    async function started(me: string): Promise<string> {
      const first = await paidVip(me);
      await vip.addPeriod({ purchaseId: first, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });
      return first;
    }

    /** Следующая оплата той же подписки — период встаёт за последним. */
    async function renewed(me: string, first: string): Promise<string> {
      const next = await paidVip(me, first);
      await vip.addPeriod({ purchaseId: next, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW });
      return next;
    }

    async function span(purchaseId: string): Promise<[number, number]> {
      const row = await prisma.vipPeriod.findUniqueOrThrow({ where: { purchaseId } });
      return [row.startsAt.getTime() - NOW.getTime(), row.endsAt.getTime() - NOW.getTime()];
    }

    it("один период в 30 суток, возврат через 10 — конец периода в момент возврата, убрано 20 суток", async () => {
      const me = await account();
      const first = await started(me);

      const cut = await vip.cutPeriod(first, new Date(NOW.getTime() + MS(10)));

      expect(cut).toEqual({ subscriptionId: first, removedSec: 20 * 86_400, until: new Date(NOW.getTime() + MS(10)) });
      expect(await span(first)).toEqual([0, MS(10)]);
      expect((await vip.state(me, NOW)).until).toEqual(new Date(NOW.getTime() + MS(10)));
    });

    it("два периода подряд, возврат первого через 10 суток — первый кончается в момент возврата, второй сдвинут на 20 суток, срок VIP меньше на 20", async () => {
      const me = await account();
      const first = await started(me);
      const second = await renewed(me, first);
      expect((await vip.state(me, NOW)).until).toEqual(new Date(NOW.getTime() + MS(60)));

      const cut = await vip.cutPeriod(first, new Date(NOW.getTime() + MS(10)));

      expect(cut).toEqual({ subscriptionId: first, removedSec: 20 * 86_400, until: new Date(NOW.getTime() + MS(40)) });
      expect(await span(first)).toEqual([0, MS(10)]);
      expect(await span(second)).toEqual([MS(10), MS(40)]);
    });

    it("возврат второго, ещё не начавшегося, — убрано всё его время, период остаётся одной миллисекундой: нулевой база не примет", async () => {
      const me = await account();
      const first = await started(me);
      const second = await renewed(me, first);

      const cut = await vip.cutPeriod(second, new Date(NOW.getTime() + MS(10)));

      expect(cut).toEqual({ subscriptionId: first, removedSec: 30 * 86_400, until: new Date(NOW.getTime() + MS(30) + 1) });
      expect(await span(first)).toEqual([0, MS(30)]);
      expect(await span(second)).toEqual([MS(30), MS(30) + 1]);
    });

    it("повтор — убрано 0, даты не меняются", async () => {
      const me = await account();
      const first = await started(me);
      const second = await renewed(me, first);
      const at = new Date(NOW.getTime() + MS(10));
      await vip.cutPeriod(first, at);
      const before = [await span(first), await span(second)];

      const again = await vip.cutPeriod(first, at);

      expect(again).toEqual({ subscriptionId: first, removedSec: 0, until: new Date(NOW.getTime() + MS(40)) });
      expect([await span(first), await span(second)]).toEqual(before);
    });

    it("периода нет — null", async () => {
      expect(await vip.cutPeriod(randomUUID(), NOW)).toBeNull();
    });

    it("период уже использован целиком — убрано 0, ничего не сдвигается", async () => {
      const me = await account();
      const first = await started(me);
      const second = await renewed(me, first);

      const cut = await vip.cutPeriod(first, new Date(NOW.getTime() + MS(45)));

      expect(cut).toEqual({ subscriptionId: first, removedSec: 0, until: new Date(NOW.getTime() + MS(60)) });
      expect(await span(first)).toEqual([0, MS(30)]);
      expect(await span(second)).toEqual([MS(30), MS(60)]);
    });

    it("не удлиняет: возврат с моментом позже конца периода ничего не меняет, раньше — режет", async () => {
      const me = await account();
      const first = await started(me);

      expect((await vip.cutPeriod(first, new Date(NOW.getTime() + MS(40))))?.removedSec).toBe(0);
      expect(await span(first)).toEqual([0, MS(30)]);
      expect((await vip.cutPeriod(first, new Date(NOW.getTime() + MS(5))))?.removedSec).toBe(25 * 86_400);
    });

    it("периоды другого аккаунта не сдвигаются", async () => {
      const me = await account();
      const other = await account();
      const first = await started(me);
      const strangers = await started(other);

      await vip.cutPeriod(first, new Date(NOW.getTime() + MS(10)));

      expect(await span(strangers)).toEqual([0, MS(30)]);
      expect((await vip.state(other, NOW)).until).toEqual(new Date(NOW.getTime() + MS(30)));
    });

    it("пять параллельных вызовов — убрано один раз, второй период сдвинут один раз", async () => {
      const me = await account();
      const first = await started(me);
      const second = await renewed(me, first);
      const at = new Date(NOW.getTime() + MS(10));

      const cuts = await Promise.all(Array.from({ length: 5 }, () => vip.cutPeriod(first, at)));

      expect(cuts.map((cut) => cut?.removedSec ?? -1).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 20 * 86_400]);
      expect(await span(first)).toEqual([0, MS(10)]);
      expect(await span(second)).toEqual([MS(10), MS(40)]);
    }, 30_000);

    it("отзыв и выдача нового периода идут одной цепочкой под общим локом: итог тот же в любом порядке", async () => {
      const me = await account();
      const first = await started(me);
      const second = await renewed(me, first);
      const third = await paidVip(me, first);

      await Promise.all([
        vip.cutPeriod(first, new Date(NOW.getTime() + MS(10))),
        vip.addPeriod({ purchaseId: third, subscriptionId: first, accountId: me, paidAt: NOW, periodSec: PERIOD_SEC, at: NOW }),
      ]);

      expect(await span(first)).toEqual([0, MS(10)]);
      expect(await span(second)).toEqual([MS(10), MS(40)]);
      expect(await span(third)).toEqual([MS(40), MS(70)]);
    }, 30_000);
  });

  describe("две подписки сразу: продление остаётся у одной (T-0140)", () => {
    const REPEATS = 20;
    const api = new FakeStarsApi();

    const chargeOf = (purchaseId: string): string => `charge-${purchaseId}`;

    /** Выдача на живой базе; платформа — подделка, остальные зависимости выдаче не нужны. */
    function fulfilment(repository: PrismaVipRepository): (purchaseId: string) => Promise<void> {
      const settings = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true" } as NodeJS.ProcessEnv);
      const providers = starsProviders(api);
      const service = new VipService(
        repository,
        new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings)),
        new PurchaseFulfillment(),
        new PaymentsHooks(),
        new SubscriptionRenewal(purchases, providers),
        {} as unknown as WalletService,
        new WalletBonuses(),
        new AdPasses(),
        accounts,
        new PurchaseRevocation(),
        restrictionsGate(),
      );
      return async (purchaseId) => {
        const row = await purchases.byId(purchaseId);
        if (row === null) throw new Error(`покупки ${purchaseId} нет`);
        await service.fulfill(row);
      };
    }

    function renewalCalls(ids: readonly string[]) {
      return api.renewals.filter((item) => ids.some((id) => chargeOf(id) === item.chargeId));
    }

    /** Две выдачи разом и всё, что должно быть верно после них и после их повтора. */
    async function bothAtOnce(fulfil: (purchaseId: string) => Promise<void>): Promise<void> {
      const me = await account();
      const ids = [await paidVip(me), await paidVip(me)];

      await Promise.all(ids.map((id) => fulfil(id)));

      const state = await vip.state(me, NOW);
      expect(state.subscriptions).toHaveLength(2);
      const winner = expectedWinner(state.subscriptions);
      const loser = ids.find((id) => id !== winner) ?? "";
      expect(state.subscriptions.filter((item) => item.renewal === "on").map((item) => item.subscriptionId)).toEqual([winner]);
      expect(state.subscriptions.find((item) => item.subscriptionId === loser)).toMatchObject({ renewal: "cancelled", cancelledBy: "game" });
      // Оплаченные периоды остаются у игрока обе: VIP идёт на 60 суток, возврата нет.
      expect(await prisma.vipPeriod.count({ where: { accountId: me } })).toBe(2);
      expect(state.until).toEqual(new Date(NOW.getTime() + 60 * DAY_MS));
      // Площадку просили выключить продление только проигравшей.
      const calls = renewalCalls(ids);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((item) => item.chargeId === chargeOf(loser) && item.canceled)).toBe(true);

      // Повтор выдач ничего не меняет и площадку не трогает.
      await Promise.all(ids.map((id) => fulfil(id)));
      expect(renewalCalls(ids)).toHaveLength(calls.length);
      expect((await vip.state(me, NOW)).subscriptions).toEqual(state.subscriptions);
    }

    it(`две выдачи параллельно на одном аккаунте — продление ровно у одной, у более ранней; ${REPEATS} повторов подряд`, async () => {
      const fulfil = fulfilment(vip);
      for (let attempt = 0; attempt < REPEATS; attempt += 1) await bothAtOnce(fulfil);
    }, 120_000);

    it(`обе выдачи читают подписки уже после обеих записей — продление не пропадает у обеих; ${REPEATS} повторов подряд`, async () => {
      for (let attempt = 0; attempt < REPEATS; attempt += 1) await bothAtOnce(fulfilment(new CrossingVipRepository(prisma, 2)));
    }, 120_000);
  });
});
