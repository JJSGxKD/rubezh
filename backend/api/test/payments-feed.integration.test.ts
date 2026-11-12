import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import { PrismaPaymentsFeedRepository } from "../src/modules/payments/payments-feed.repository.js";
import { PaymentsFeed, type FeedFilters } from "../src/modules/payments/payments-feed.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import type { PurchaseSupport } from "../src/modules/payments/purchase-support.js";
import type { PurchaseProduct } from "../src/modules/payments/purchase-types.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";

/**
 * Лента платежей на настоящем Postgres (tasks/T-0429, docs/17-testing-strategy.md
 * §4.2). Адрес — TEST_DATABASE_URL; без него пропускается.
 *
 * Память этого не покажет: условия пяти состояний, поиск по продлениям,
 * страницы по курсору при одинаковом времени счёта и фильтр по площадке
 * аккаунта живут в запросе к базе.
 *
 * Все покупки теста лежат в окне января 2031 года: настоящие тесты и прежние
 * прогоны в то же окно не попадают, а лента спрашивается только с этим окном.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const WINDOW = { from: new Date(Date.UTC(2031, 0, 1)), to: new Date(Date.UTC(2031, 1, 1)) };
const at = (minutes: number): Date => new Date(Date.UTC(2031, 0, 10, 10, minutes));

/** Идентификатор оплаты нового вида Telegram — 131 знак (сбой 11.11.2026). */
const LONG_CHARGE_ID = `stx${"0123456789abcdef".repeat(8)}`;

const ACTOR: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "777000111" };

describe.skipIf(DATABASE_URL === "")("лента платежей на живом Postgres", () => {
  let prisma: PrismaClient;
  let feed: PaymentsFeed;
  let telegramAccount = "";
  let vkAccount = "";
  /** метка покупки → её id: P1 — первая подписка VIP, P2 — её продление и так далее */
  const id: Record<"P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8", string> = {
    P1: randomUUID(),
    P2: randomUUID(),
    P3: randomUUID(),
    P4: randomUUID(),
    P5: randomUUID(),
    P6: randomUUID(),
    P7: randomUUID(),
    P8: randomUUID(),
  };

  async function wipeWindow(): Promise<void> {
    const where = { invoicedAt: { gte: WINDOW.from, lt: WINDOW.to } };
    // Продления ссылаются на первую покупку (Restrict): сначала они.
    await prisma.purchase.deleteMany({ where: { ...where, renewalOf: { not: null } } });
    await prisma.purchase.deleteMany({ where });
  }

  function filters(patch: Partial<FeedFilters> = {}): FeedFilters {
    return { status: null, product: null, from: WINDOW.from, to: WINDOW.to, accountId: null, platform: null, mode: null, search: null, ...patch };
  }

  /** Все покупки окна, подходящие под фильтр, по одной странице из ста. */
  async function ids(patch: Partial<FeedFilters> = {}): Promise<string[]> {
    const page = await feed.page(ACTOR, filters(patch), null, 100);
    return page.rows.map((row) => row.purchase.purchaseId).sort();
  }

  const sorted = (...keys: (keyof typeof id)[]): string[] => keys.map((key) => id[key]).sort();

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    const accounts = new PrismaAccountRepository(prisma);
    const arrival = (platform: "telegram" | "vk", name: string) => ({ platform, platformUserId: String(800_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null });
    telegramAccount = (await accounts.upsert(arrival("telegram", "Стрелок"), Date.now())).accountId;
    vkAccount = (await accounts.upsert(arrival("vk", "Лучник"), Date.now())).accountId;
    await wipeWindow();

    const base = { priceStars: 50, chargedStars: 50, mode: "live" as const };
    const row = (key: keyof typeof id, accountId: string, product: PurchaseProduct, minutes: number, patch: Record<string, unknown> = {}) => ({
      purchaseId: id[key],
      accountId,
      product,
      sku: product === "continue_run" ? null : product,
      ...base,
      status: "pending" as const,
      invoicedAt: at(minutes),
      ...patch,
    });
    const paidAt = (minutes: number) => ({ status: "paid" as const, paidAt: at(minutes), telegramChargeId: `charge-${randomUUID()}` });

    // Первая подписка VIP выдана; её продление оплачено, но не выдано.
    await prisma.purchase.create({ data: row("P1", telegramAccount, "vip", 0, { ...paidAt(0), fulfilledAt: at(0) }) });
    await prisma.purchase.create({ data: row("P2", telegramAccount, "vip", 1, { ...paidAt(1), renewalOf: id.P1 }) });
    await prisma.purchase.create({ data: row("P3", telegramAccount, "shop_item", 2) });
    await prisma.purchase.create({ data: row("P4", telegramAccount, "shop_item", 3, { ...paidAt(3), telegramChargeId: LONG_CHARGE_ID }) });
    // Второй шанс выдаётся самой оплатой: fulfilled_at пуст всегда, и «не выдан» он не бывает.
    await prisma.purchase.create({ data: row("P5", telegramAccount, "continue_run", 3, { ...paidAt(3) }) });
    await prisma.purchase.create({
      data: row("P6", vkAccount, "shop_item", 4, { ...paidAt(4), fulfilledAt: at(4), refundReason: "manual", refundRequestedAt: at(20) }),
    });
    await prisma.purchase.create({
      data: row("P7", vkAccount, "shop_item", 5, { ...paidAt(5), status: "refunded", fulfilledAt: at(5), refundReason: "external", refundRequestedAt: at(21), refundedAt: at(22) }),
    });
    await prisma.purchase.create({ data: row("P8", vkAccount, "donation", 6, { ...paidAt(6), mode: "test", chargedStars: 1, fulfilledAt: at(6) }) });

    const fulfillment = new PurchaseFulfillment();
    for (const product of ["shop_item", "vip", "donation"] as const) fulfillment.register(product, async () => undefined);
    const roles = { can: async () => true, require: async () => undefined, auditPage: async () => [], audit: async () => undefined } as unknown as RolesService;
    const support = { actionsFor: () => [] } as unknown as PurchaseSupport;
    feed = new PaymentsFeed(new PrismaPaymentsFeedRepository(prisma), new PaymentFeedSources(), support, fulfillment, roles, accounts);
  });

  afterAll(async () => {
    await wipeWindow();
    await prisma.$disconnect();
  });

  it("каждое из пяти состояний отдаёт ровно свои строки", async () => {
    expect(await ids({ status: "pending" })).toEqual(sorted("P3"));
    expect(await ids({ status: "paid" })).toEqual(sorted("P1", "P2", "P4", "P5", "P8"));
    expect(await ids({ status: "undelivered" })).toEqual(sorted("P2", "P4"));
    expect(await ids({ status: "refund_requested" })).toEqual(sorted("P6"));
    expect(await ids({ status: "refunded" })).toEqual(sorted("P7"));
  });

  it("без состояния — все восемь; «не выдан» не отдаёт второй шанс: выдачи у него нет", async () => {
    expect(await ids()).toEqual(sorted("P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"));
    expect(await ids({ status: "undelivered" })).not.toContain(id.P5);
  });

  it("страницы по три по курсору — без пропусков и повторов, равное время счёта не теряется", async () => {
    // Свежие счета первыми; при равном времени — id по убыванию.
    const minutes = { P1: 0, P2: 1, P3: 2, P4: 3, P5: 3, P6: 4, P7: 5, P8: 6 } as const;
    const expected = (Object.keys(id) as (keyof typeof id)[])
      .sort((a, b) => minutes[b] - minutes[a] || (id[b] > id[a] ? 1 : -1))
      .map((key) => id[key]);
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;

    do {
      const page = await feed.page(ACTOR, filters(), cursor, 3);
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((row) => row.purchase.purchaseId));
      cursor = page.next;
    } while (cursor !== null);

    expect(sizes).toEqual([3, 3, 2]);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(8);
  });

  it("поиск по UUID первой покупки VIP — она и её продление", async () => {
    expect(await ids({ search: { purchaseId: id.P1 } })).toEqual(sorted("P1", "P2"));
    expect(await ids({ search: { purchaseId: id.P2 } })).toEqual(sorted("P2"));
    expect(await ids({ search: { purchaseId: randomUUID() } })).toEqual([]);
  });

  it("поиск по идентификатору оплаты длиной 131 знак — ровно эта покупка; частичного совпадения нет", async () => {
    expect(LONG_CHARGE_ID).toHaveLength(131);

    expect(await ids({ search: { chargeId: LONG_CHARGE_ID } })).toEqual(sorted("P4"));
    expect(await ids({ search: { chargeId: LONG_CHARGE_ID.slice(0, 40) } })).toEqual([]);
    expect(await ids({ search: { chargeId: `${LONG_CHARGE_ID}0` } })).toEqual([]);
  });

  it("период по времени счёта: from — включительно, to — исключительно", async () => {
    expect(await ids({ from: at(3), to: at(5) })).toEqual(sorted("P4", "P5", "P6"));
    expect(await ids({ from: at(3), to: at(3) })).toEqual([]);
  });

  it("товар, площадка аккаунта, режим и игрок", async () => {
    expect(await ids({ product: "continue_run" })).toEqual(sorted("P5"));
    expect(await ids({ product: "vip" })).toEqual(sorted("P1", "P2"));
    expect(await ids({ platform: "vk" })).toEqual(sorted("P6", "P7", "P8"));
    expect(await ids({ platform: "telegram" })).toEqual(sorted("P1", "P2", "P3", "P4", "P5"));
    expect(await ids({ platform: "max" })).toEqual([]);
    expect(await ids({ mode: "test" })).toEqual(sorted("P8"));
    expect(await ids({ accountId: telegramAccount })).toEqual(sorted("P1", "P2", "P3", "P4", "P5"));
    expect(await ids({ accountId: vkAccount, status: "refunded" })).toEqual(sorted("P7"));
  });

  it("фильтры складываются: состояние, площадка и товар вместе", async () => {
    expect(await ids({ status: "paid", platform: "telegram", product: "shop_item" })).toEqual(sorted("P4"));
    expect(await ids({ status: "paid", platform: "vk", mode: "live" })).toEqual([]);
  });

  it("у строки — игрок с площадкой его аккаунта", async () => {
    const page = await feed.page(ACTOR, filters({ platform: "vk" }), null, 100);

    expect(page.rows.map((row) => row.account)).toEqual(
      page.rows.map(() => ({ accountId: vkAccount, displayName: "Лучник", platform: "vk" })),
    );
  });

  it("карточка: первая подписка видит продление, продление — первую; идентификатор игрока на площадке отдаётся с правом", async () => {
    const first = await feed.card(ACTOR, id.P1);
    const renewal = await feed.card(ACTOR, id.P2);

    expect(first.renewals.map((row) => row.purchaseId)).toEqual([id.P2]);
    expect(first.renewalOf).toBeNull();
    expect(renewal.renewalOf?.purchaseId).toBe(id.P1);
    expect(renewal.renewals).toEqual([]);
    expect(first.account).toMatchObject({ accountId: telegramAccount, displayName: "Стрелок", platform: "telegram" });
    expect(first.account.pii?.platformUserId).toMatch(/^\d+$/);
    expect(first.timeline.map((line) => line.kind)).toEqual(["invoice", "paid", "fulfilled", "renewal"]);
  });
});
