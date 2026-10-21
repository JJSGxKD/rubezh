import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Global, Module, type Type } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_MODULES } from "../src/app.module.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { HealthController } from "../src/health/health.controller.js";
import { createHttpApp } from "../src/http-app.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { PrismaDonationsRepository } from "../src/modules/donations/donations.repository.js";
import { DonationsService } from "../src/modules/donations/donations.service.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { PrismaPurchasesRepository, type ShopInvoiceRecord } from "../src/modules/payments/purchases.repository.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { switchesOf } from "./helpers/notify-targets.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Донаты на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): донат — новая строка на каждый счёт,
 * знак ставится однажды и под гонкой, снимается только когда другого
 * действующего доната нет; оплата, выдача и внешний возврат проходят цепочку
 * целиком на настоящих таблицах.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
const NOW = new Date(Date.UTC(2026, 9, 19, 9));

describe.skipIf(DATABASE_URL === "")("донаты на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let purchases: PrismaPurchasesRepository;
  let donations: PrismaDonationsRepository;

  async function account(): Promise<{ accountId: string; platformUserId: string }> {
    const platformUserId = String(960_000_000 + Math.floor(Math.random() * 30_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Донатор", username: null }, Date.now());
    return { accountId: created.accountId, platformUserId };
  }

  function record(accountId: string, patch: Partial<ShopInvoiceRecord> = {}): ShopInvoiceRecord {
    return { purchaseId: randomUUID(), accountId, product: "donation", sku: "donation", onceKey: null, priceStars: 50, chargedStars: 50, mode: "live", invoicedAt: NOW, ...patch };
  }

  /** Донат, оплаченный и записанный так, как его оставляет подтверждение площадки. */
  async function paidDonation(accountId: string, patch: Partial<ShopInvoiceRecord> = {}): Promise<{ purchaseId: string; chargeId: string }> {
    const opened = await purchases.openShopInvoice(record(accountId, patch));
    if (opened.kind !== "opened") throw new Error("счёт не открыт");
    const chargeId = `charge-${opened.purchase.purchaseId}`;
    await purchases.markPaid({ purchaseId: opened.purchase.purchaseId, chargeId, chargedStars: opened.purchase.chargedStars, paidAt: NOW });
    return { purchaseId: opened.purchase.purchaseId, chargeId };
  }

  async function supporterAt(accountId: string): Promise<Date | null> {
    const rows = await prisma.$queryRaw<{ supporter_at: Date | null }[]>`SELECT supporter_at FROM account WHERE account_id = ${accountId}::uuid`;
    const row = rows[0];
    if (row === undefined) throw new Error("аккаунта нет");
    return row.supporter_at;
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    purchases = new PrismaPurchasesRepository(prisma);
    donations = new PrismaDonationsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("после миграции в перечислении есть значение donation, а у аккаунта — колонка supporter_at", async () => {
    const values = await prisma.$queryRaw<{ value: string }[]>`SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'PurchaseProduct'`;
    expect(values.map((row) => row.value)).toContain("donation");
    const columns = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'supporter_at' AND table_schema = current_schema()`;
    expect(columns).toEqual([{ column_name: "supporter_at", data_type: "timestamp with time zone" }]);
  });

  it("два счёта на 50 звёзд одного аккаунта — две разные строки: донат не разовый", async () => {
    const me = await account();
    const first = await purchases.openShopInvoice(record(me.accountId));
    const second = await purchases.openShopInvoice(record(me.accountId));
    if (first.kind !== "opened" || second.kind !== "opened") throw new Error("счёт не открыт");
    expect(first.purchase.purchaseId).not.toBe(second.purchase.purchaseId);
    expect(first.purchase).toMatchObject({ product: "donation", sku: "donation", runId: null, continueNo: null, elapsedSec: null, priceStars: 50, fulfilledAt: null });
    expect((await purchases.byAccount(me.accountId, 10)).filter((row) => row.product === "donation")).toHaveLength(2);
  });

  it("база не примет донат с полями второго шанса и без sku; несуществующий забег не примет внешний ключ", async () => {
    const me = await account();
    await expect(prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, sku, continue_no, elapsed_sec, price_stars, charged_stars, mode, status, invoiced_at)
      VALUES (${randomUUID()}::uuid, ${me.accountId}::uuid, 'donation', 'donation', 1, 125, 50, 50, 'live', 'pending', now())`).rejects.toThrow(/purchase_continue_check/);
    await expect(prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, price_stars, charged_stars, mode, status, invoiced_at)
      VALUES (${randomUUID()}::uuid, ${me.accountId}::uuid, 'donation', 50, 50, 'live', 'pending', now())`).rejects.toThrow(/purchase_sku_check/);
    await expect(prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, sku, run_id, price_stars, charged_stars, mode, status, invoiced_at)
      VALUES (${randomUUID()}::uuid, ${me.accountId}::uuid, 'donation', 'donation', ${randomUUID()}, 50, 50, 'live', 'pending', now())`).rejects.toThrow();
  });

  it("20 параллельных markSupporter с разными датами: знак стоит, дата — одна из них и не меняется после ещё одного вызова", async () => {
    const me = await account();
    const dates = Array.from({ length: 20 }, (_, index) => new Date(NOW.getTime() + index * 60_000));
    expect(await supporterAt(me.accountId)).toBeNull();
    expect(await donations.isSupporter(me.accountId)).toBe(false);

    await Promise.all(dates.map((at) => donations.markSupporter(me.accountId, at)));

    const stored = await supporterAt(me.accountId);
    expect(stored).not.toBeNull();
    expect(dates.map((date) => date.getTime())).toContain(stored?.getTime());
    expect(await donations.isSupporter(me.accountId)).toBe(true);

    await donations.markSupporter(me.accountId, new Date(NOW.getTime() + 86_400_000));
    expect(await supporterAt(me.accountId)).toEqual(stored);
  });

  it("знак чужого аккаунта не затронут; неизвестный аккаунт — не донатор, пометка ему безвредна", async () => {
    const me = await account();
    const other = await account();
    await donations.markSupporter(me.accountId, NOW);
    expect(await donations.isSupporter(other.accountId)).toBe(false);
    expect(await donations.isSupporter(randomUUID())).toBe(false);
    await expect(donations.markSupporter(randomUUID(), NOW)).resolves.toBeUndefined();
  });

  describe("clearSupporterUnlessOther", () => {
    it("единственный оплаченный донат — знак снят, повтор безвреден и отвечает так же", async () => {
      const me = await account();
      const only = await paidDonation(me.accountId);
      await donations.markSupporter(me.accountId, NOW);

      expect(await donations.clearSupporterUnlessOther(me.accountId, only.purchaseId)).toBe(true);
      expect(await supporterAt(me.accountId)).toBeNull();
      expect(await donations.clearSupporterUnlessOther(me.accountId, only.purchaseId)).toBe(true);
      expect(await donations.isSupporter(me.accountId)).toBe(false);
    });

    it("второй оплаченный и не возвращённый донат — знак остаётся", async () => {
      const me = await account();
      const first = await paidDonation(me.accountId);
      await paidDonation(me.accountId, { priceStars: 250, chargedStars: 250 });
      await donations.markSupporter(me.accountId, NOW);

      expect(await donations.clearSupporterUnlessOther(me.accountId, first.purchaseId)).toBe(false);
      expect(await supporterAt(me.accountId)).toEqual(NOW);
    });

    it("второй донат возвращён — знак снят", async () => {
      const me = await account();
      const first = await paidDonation(me.accountId);
      const second = await paidDonation(me.accountId);
      await donations.markSupporter(me.accountId, NOW);
      await purchases.markRefunded(second.chargeId, new Date(NOW.getTime() + 60_000));

      expect(await donations.clearSupporterUnlessOther(me.accountId, first.purchaseId)).toBe(true);
      expect(await supporterAt(me.accountId)).toBeNull();
    });

    it("возврат уже заказан, а площадка ещё не подтвердила — такой донат знак не держит", async () => {
      const me = await account();
      const first = await paidDonation(me.accountId);
      const second = await paidDonation(me.accountId);
      await donations.markSupporter(me.accountId, NOW);
      await purchases.requestRefund(second.purchaseId, "manual", new Date(NOW.getTime() + 60_000));

      expect(await donations.clearSupporterUnlessOther(me.accountId, first.purchaseId)).toBe(true);
    });

    it("не держат знак ни неоплаченный счёт, ни чужой донат, ни оплаченный товар магазина", async () => {
      const me = await account();
      const stranger = await account();
      const first = await paidDonation(me.accountId);
      await purchases.openShopInvoice(record(me.accountId));
      await paidDonation(stranger.accountId);
      await paidDonation(me.accountId, { product: "shop_item", sku: "gems_60" });
      await donations.markSupporter(me.accountId, NOW);
      await donations.markSupporter(stranger.accountId, NOW);

      expect(await donations.clearSupporterUnlessOther(me.accountId, first.purchaseId)).toBe(true);
      expect(await donations.isSupporter(me.accountId)).toBe(false);
      expect(await donations.isSupporter(stranger.accountId)).toBe(true);
    });
  });

  describe("оплата, выдача и возврат на настоящих таблицах", () => {
    function setup() {
      const settings: AppConfig = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true" } as NodeJS.ProcessEnv);
      const api = new FakeStarsApi();
      const providers = starsProviders(api);
      const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
      const fulfillment = new PurchaseFulfillment();
      const revocation = new PurchaseRevocation();
      const service = new DonationsService(payments, fulfillment, revocation, donations, restrictionsGate(new MemoryRestrictionsRepository()), panelSettings());
      service.onModuleInit();
      const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), new PaymentsHooks(), revocation);
      const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers, revocation), new RunsHooks(), providers, fulfillment, purchases);
      return { api, service, confirmation, queue };
    }

    it("заказ → оплата → знак на аккаунте и покупка выдана; повтор подтверждения знак не трогает; внешний возврат снимает", async () => {
      const ctx = setup();
      const me = await account();
      const ref = { accountId: me.accountId, platform: "telegram" as const, platformUserId: me.platformUserId };

      const view = await ctx.service.view(ref);
      expect(view).toMatchObject({ stars: { min: 1, max: 10_000, presets: [50, 100, 250, 500, 1000], mode: "live" }, supporter: false });

      const invoice = await ctx.service.order(ref, 250);
      expect(invoice).toMatchObject({ sku: "donation", status: "pending", priceStars: 250, chargedStars: 250 });
      const confirm = (chargeId: string) =>
        ctx.queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: invoice.purchaseId, payerId: me.platformUserId, currency: "XTR", totalAmount: 250 } } });
      // Идентификатор оплаты уникален на всю таблицу, а база между прогонами не чистится.
      const chargeId = `charge-flow-${me.accountId}`;
      await confirm(chargeId);

      const bornAt = await supporterAt(me.accountId);
      expect(bornAt).not.toBeNull();
      expect((await ctx.service.view(ref)).supporter).toBe(true);
      expect(await purchases.byId(invoice.purchaseId)).toMatchObject({ status: "paid", product: "donation", fulfilledAt: expect.any(Date) });

      await confirm(chargeId);
      expect(await supporterAt(me.accountId)).toEqual(bornAt);

      await ctx.confirmation.refunded(chargeId, NOW.getTime() + 60_000);
      expect(await supporterAt(me.accountId)).toBeNull();
      expect((await ctx.service.view(ref)).supporter).toBe(false);
    });

    it("внешний возврат одного из двух донатов знак оставляет", async () => {
      const ctx = setup();
      const me = await account();
      const ref = { accountId: me.accountId, platform: "telegram" as const, platformUserId: me.platformUserId };
      for (const chargeId of ["charge-a", "charge-b"]) {
        const invoice = await ctx.service.order(ref, 100);
        await ctx.queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId: `${chargeId}-${me.accountId}`, payload: invoice.purchaseId, payerId: me.platformUserId, currency: "XTR", totalAmount: 100 } } });
      }

      await ctx.confirmation.refunded(`charge-a-${me.accountId}`, NOW.getTime() + 60_000);

      expect(await donations.isSupporter(me.accountId)).toBe(true);
    });
  });
});

/**
 * Приложение целиком на живых Postgres и Redis (как `app-boot.integration.test.ts`):
 * сервис доната поднимается с настоящими выдачей и отзывом из модуля оплаты, а
 * не с пустышками по умолчанию, и маршруты отвечают на настоящей базе.
 */
describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("донаты в собранном приложении", () => {
  it("DonationsService зарегистрировал выдачу и отзыв в общих реестрах; при выключенной оплате GET — 200 без звёзд, POST — 404", async () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      ...AUTH_ENV,
      DATABASE_URL,
      REDIS_URL,
      TELEGRAM_API_ROOT: "http://127.0.0.1:9",
      TELEGRAM_BOT_UPDATES: "off",
    } as NodeJS.ProcessEnv);

    @Global()
    @Module({ providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] })
    class TestConfigModule {}

    @Module({ imports: [TestConfigModule, ...APP_MODULES], controllers: [HealthController] })
    class BootModule {}

    const prisma = testPrisma(DATABASE_URL, 2);
    const app = await createHttpApp(BootModule as Type<unknown>, { logger: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      expect(app.get(DonationsService, { strict: false })).toBeInstanceOf(DonationsService);
      // Общие реестры модуля оплаты, а не запасные из конструктора.
      expect(app.get(PurchaseFulfillment, { strict: false }).products()).toContain("donation");
      const revocation = app.get(PurchaseRevocation, { strict: false });
      const lines = await revocation.revoke(
        {
          purchaseId: randomUUID(),
          accountId: randomUUID(),
          product: "donation",
          runId: null,
          continueNo: null,
          elapsedSec: null,
          sku: "donation",
          priceStars: 50,
          chargedStars: 50,
          mode: "live",
          status: "refunded",
          telegramChargeId: null,
          invoicedAt: NOW,
          paidAt: NOW,
          refundReason: "external",
          refundRequestedAt: null,
          refundedAt: NOW,
          fulfilledAt: NOW,
          renewalOf: null,
        },
        NOW,
      );
      expect(lines.lines[0]).not.toContain("ничего — товар не забирается");

      const accounts = new PrismaAccountRepository(prisma);
      const platformUserId = String(960_000_000 + Math.floor(Math.random() * 30_000_000));
      const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Донатор", username: null }, Date.now());
      const token = await signAccessToken({ accountId: created.accountId, platform: "telegram", platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      const headers = { authorization: `Bearer ${token}` };

      expect((await app.inject({ method: "GET", url: "/api/v1/donations" })).statusCode).toBe(401);
      const view = await app.inject({ method: "GET", url: "/api/v1/donations", headers });
      expect(view.statusCode).toBe(200);
      expect(view.json<{ data: unknown }>().data).toEqual({ stars: null, tribute: null, supporter: false });

      const order = await app.inject({ method: "POST", url: "/api/v1/donations/orders", headers, payload: { amount: 50 } });
      expect(order.statusCode).toBe(404);
      expect(order.json<{ error: { code: string } }>().error.code).toBe("endpoint_disabled");
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
