import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaPurchasesRepository, type ShopInvoiceRecord } from "../src/modules/payments/purchases.repository.js";

/**
 * Покупки магазина на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск): разовый товар — одна строка
 * и под гонкой, оплаченный второй счёт не получает, выдача помечается
 * однажды; база не примет товар без `sku` и второй шанс без забега.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 8, 30, 9));

describe.skipIf(DATABASE_URL === "")("покупки магазина на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let purchases: PrismaPurchasesRepository;

  async function account(): Promise<{ accountId: string; platformUserId: string }> {
    const platformUserId = String(940_000_000 + Math.floor(Math.random() * 30_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Магазин", username: null }, Date.now());
    return { accountId: created.accountId, platformUserId };
  }

  function record(accountId: string, patch: Partial<ShopInvoiceRecord> = {}): ShopInvoiceRecord {
    return { purchaseId: randomUUID(), accountId, product: "shop_item", sku: "gems_60", onceKey: null, priceStars: 50, chargedStars: 50, mode: "live", invoicedAt: NOW, ...patch };
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    purchases = new PrismaPurchasesRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("повторяемый товар — новая строка на каждый счёт; проверка перед оплатой видит владельца и не видит забега", async () => {
    const me = await account();
    const first = await purchases.openShopInvoice(record(me.accountId));
    const second = await purchases.openShopInvoice(record(me.accountId));
    expect(first.kind === "opened" && second.kind === "opened" && first.purchase.purchaseId !== second.purchase.purchaseId).toBe(true);
    if (first.kind !== "opened") throw new Error("счёт не открыт");
    expect(first.purchase).toMatchObject({ product: "shop_item", sku: "gems_60", runId: null, continueNo: null, elapsedSec: null, fulfilledAt: null });

    const view = await purchases.checkout(first.purchase.purchaseId);
    expect(view).toMatchObject({ platformUserId: me.platformUserId, runFinished: false });
  });

  it("разовый товар — одна строка и под гонкой; после оплаты второй счёт не открывается, витрина видит купленным", async () => {
    const me = await account();
    const onceKey = `starter:${me.accountId}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => purchases.openShopInvoice(record(me.accountId, { sku: "starter", onceKey }))));
    const ids = new Set(results.flatMap((result) => (result.kind === "foreign" ? [] : [result.purchase.purchaseId])));
    expect(ids.size).toBe(1);
    const [purchaseId] = [...ids];
    if (purchaseId === undefined) throw new Error("нет покупки");
    expect(await purchases.ownedOnce(me.accountId, [onceKey])).toEqual([]);

    await purchases.markPaid({ purchaseId, chargeId: `charge-${purchaseId}`, chargedStars: 50, paidAt: NOW });
    expect(await purchases.openShopInvoice(record(me.accountId, { sku: "starter", onceKey }))).toMatchObject({ kind: "paid", purchase: { purchaseId } });
    expect(await purchases.ownedOnce(me.accountId, [onceKey, `other:${me.accountId}`])).toEqual([onceKey]);

    const stranger = await account();
    expect(await purchases.openShopInvoice(record(stranger.accountId, { sku: "starter", onceKey }))).toEqual({ kind: "foreign" });
  });

  it("выдача помечается однажды: первое время остаётся", async () => {
    const me = await account();
    const opened = await purchases.openShopInvoice(record(me.accountId));
    if (opened.kind !== "opened") throw new Error("счёт не открыт");
    const id = opened.purchase.purchaseId;
    await purchases.markFulfilled(id, NOW);
    await purchases.markFulfilled(id, new Date(NOW.getTime() + 60_000));
    expect((await purchases.byId(id))?.fulfilledAt).toEqual(NOW);
    expect((await purchases.byAccount(me.accountId, 10)).map((row) => row.purchaseId)).toContain(id);
  });

  it("продление подписки — своя строка со ссылкой на первую; повтор оплаты — та же строка; не подписку не продлить", async () => {
    const me = await account();
    const opened = await purchases.openShopInvoice(record(me.accountId, { product: "vip", sku: "vip_month", priceStars: 200, chargedStars: 200 }));
    if (opened.kind !== "opened") throw new Error("счёт не открыт");
    const first = opened.purchase.purchaseId;
    const renewal = { firstId: first, purchaseId: randomUUID(), chargeId: `renew-${first}`, chargedStars: 200, paidAt: new Date(NOW.getTime() + 30 * 86_400_000) };

    expect(await purchases.markRenewal(renewal)).toEqual({ kind: "unknown" });
    await purchases.markPaid({ purchaseId: first, chargeId: `charge-${first}`, chargedStars: 200, paidAt: NOW });
    // Две доставки одного продления разом: строку заводит одна, какая — решает гонка.
    const results = await Promise.all([purchases.markRenewal(renewal), purchases.markRenewal({ ...renewal, purchaseId: randomUUID() })]);
    expect(results.map((result) => result.kind).sort()).toEqual(["duplicate", "paid"]);
    const recorded = results.find((result) => result.kind === "paid");
    if (recorded?.kind !== "paid") throw new Error("продление не записано");
    const renewalId = recorded.purchase.purchaseId;
    expect(results.every((result) => result.kind !== "unknown" && result.purchase.purchaseId === renewalId)).toBe(true);
    expect(await purchases.byId(renewalId)).toMatchObject({ product: "vip", sku: "vip_month", status: "paid", renewalOf: first, priceStars: 200, mode: "live" });
    expect(await purchases.markRenewal({ ...renewal, firstId: renewalId, chargeId: `x-${first}`, purchaseId: randomUUID() })).toEqual({ kind: "unknown" });

    const shop = await purchases.openShopInvoice(record(me.accountId));
    if (shop.kind !== "opened") throw new Error("счёт не открыт");
    await purchases.markPaid({ purchaseId: shop.purchase.purchaseId, chargeId: `charge-${shop.purchase.purchaseId}`, chargedStars: 50, paidAt: NOW });
    expect(await purchases.markRenewal({ ...renewal, firstId: shop.purchase.purchaseId, chargeId: `y-${first}`, purchaseId: randomUUID() })).toEqual({ kind: "unknown" });
  });

  it("база не примет товар магазина без sku и второй шанс без забега", async () => {
    const me = await account();
    await expect(prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, price_stars, charged_stars, mode, status, invoiced_at)
      VALUES (${randomUUID()}::uuid, ${me.accountId}::uuid, 'shop_item', 50, 50, 'live', 'pending', now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, sku, price_stars, charged_stars, mode, status, invoiced_at)
      VALUES (${randomUUID()}::uuid, ${me.accountId}::uuid, 'continue_run', 'gems_60', 50, 50, 'live', 'pending', now())`).rejects.toThrow();
  });
});
