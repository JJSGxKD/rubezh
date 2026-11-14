import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaEmblemsRepository } from "../src/modules/achievements/emblems.repository.js";
import { PrismaAppearanceGrantsRepository } from "../src/modules/appearance/appearance-grants.repository.js";
import type { AppearanceChoice, AppearanceView } from "../src/modules/appearance/appearance-rules.js";
import { AppearanceController } from "../src/modules/appearance/appearance.controller.js";
import { PrismaAppearanceRepository } from "../src/modules/appearance/appearance.repository.js";
import { AppearanceService } from "../src/modules/appearance/appearance.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import type { ItemsService } from "../src/modules/items/items.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { KeeperSet, PrismaFirstWinRepository } from "../src/modules/shop/keeper-set.js";
import { ShopChoice } from "../src/modules/shop/shop-choice.js";
import { PrismaShopOverrideRepository, ShopOverrides } from "../src/modules/shop/shop-overrides.js";
import { PrismaShopPromoRepository } from "../src/modules/shop/shop-promo.repository.js";
import { ShopPromoService } from "../src/modules/shop/shop-promo.service.js";
import { ShopController } from "../src/modules/shop/shop.controller.js";
import { ShopService, type ShopView } from "../src/modules/shop/shop.service.js";
import { ShowcaseService } from "../src/modules/shop/showcase.service.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * «Набор хранителя» на живых Postgres и Redis (tasks/T-0245, docs/35-stage4-plan.md Р155;
 * адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск).
 *
 * Память этого не покажет: первая победа читается одним запросом по таблице забегов, а выдача
 * окраса — строка с составным ключом и `ON CONFLICT DO NOTHING`, которая обязана выдержать
 * гонку двух заданий выдачи и пережить возврат ровно по своей покупке.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 14);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const HOUR = 3_600_000;

describe.skipIf(!live)("набор хранителя на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let shop: ShopService;
  let appearance: AppearanceService;
  let confirmation: PaymentConfirmation;
  let queue: PaymentsQueue;
  let stars: FakeStarsApi;
  const restrictions = new MemoryRestrictionsRepository();

  async function player(): Promise<AccountRef> {
    const platformUserId = String(960_000_000 + Math.floor(Math.random() * 30_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Хранитель", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId };
  }

  /** Забег, как его оставляет итог: по умолчанию честная победа над стражем. */
  async function run(accountId: string, finishedAt: Date, patch: { verdict?: "ok" | "suspicious" | "rejected"; cheats?: boolean; reached?: boolean; clearedSec?: number | null; review?: string | null } = {}): Promise<string> {
    const runId = randomUUID();
    await prisma.run.create({
      data: {
        runId,
        accountId,
        status: "finished",
        difficulty: "hard",
        startingWeaponId: "spark",
        contentHash: "h",
        startedAt: new Date(finishedAt.getTime() - 700_000),
        finishedAt,
        survivalSec: 700,
        outcome: "died",
        verdict: patch.verdict ?? "ok",
        cheats: patch.cheats ?? false,
        rubezhReached: patch.reached ?? true,
        rubezhClearedSec: patch.clearedSec === undefined ? 650 : patch.clearedSec,
        reviewOutcome: patch.review ?? null,
      },
    });
    return runId;
  }

  async function pay(me: AccountRef, purchaseId: string, chargeId = `charge-${purchaseId}`): Promise<void> {
    const row = await prisma.purchase.findUniqueOrThrow({ where: { purchaseId } });
    await queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: purchaseId, payerId: me.platformUserId, currency: "XTR", totalAmount: row.chargedStars } } });
  }

  async function grantRows(accountId: string): Promise<{ appearance_id: string; source: string; purchase_id: string | null }[]> {
    return await prisma.$queryRaw`SELECT appearance_id, source, purchase_id::text AS purchase_id FROM appearance_grant WHERE account_id = ${accountId}::uuid ORDER BY appearance_id`;
  }

  async function purchaseCount(accountId: string): Promise<number> {
    return await prisma.purchase.count({ where: { accountId, sku: "keeper_set" } });
  }

  const skus = (view: ShopView) => view.items.map((item) => item.sku);
  /** Номер оплаты уникален в базе, а тестовая база живёт между прогонами. */
  const chargeId = (name: string) => `${name}-${randomUUID()}`;

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);

    const purchases = new PrismaPurchasesRepository(prisma);
    stars = new FakeStarsApi();
    const providers = starsProviders(stars);
    const payments = new PaymentsService(config, purchases, new MemoryRunsRepository(), providers, switchesOf(config));
    const fulfillment = new PurchaseFulfillment();
    const revocation = new PurchaseRevocation();
    const items = { inventory: async () => ({ equipped: {} }) };
    shop = new ShopService(
      payments,
      fulfillment,
      wallet,
      items as unknown as ItemsService,
      new ShopPromoService(new PrismaShopPromoRepository(prisma), roles),
      panelSettings(),
      revocation,
      restrictionsGate(restrictions),
      new ShopChoice(prisma, redis, "test:keeper-set:choice"),
      new ShopOverrides(new PrismaShopOverrideRepository(prisma)),
      new KeeperSet(new PrismaFirstWinRepository(prisma)),
      new PrismaAppearanceGrantsRepository(prisma),
    );
    shop.onModuleInit();
    confirmation = new PaymentConfirmation(config, purchases, providers, switchesOf(config), new PaymentsHooks(), revocation);
    queue = new PaymentsQueue(config, confirmation, new PaymentRefunds(purchases, providers, new PurchaseRevocation()), new RunsHooks(), providers, fulfillment, purchases);

    const unused = {} as never;
    const rolesStub = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
    const tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, new RunsHooks(), rolesStub, unused, unused, unused);
    appearance = new AppearanceService(tasks, new PrismaAppearanceRepository(prisma), new PrismaEmblemsRepository(prisma), new PrismaAppearanceGrantsRepository(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("окно после первой победы", () => {
    it("первая победа — витрина несёт набор со сроком победа + 48 часов; без победы набора нет", async () => {
      const me = await player();
      const win = new Date(Date.now() - 2 * HOUR);
      expect(skus(await shop.view(me))).not.toContain("keeper_set");

      await run(me.accountId, win);
      const view = await shop.view(me);

      expect(skus(view)[0]).toBe("keeper_set");
      expect(view.items[0]).toMatchObject({ kind: "bundle", stars: 250, fullStars: null, promo: null, once: true, owned: false, appearance: "dawn", until: new Date(win.getTime() + 48 * HOUR), contents: [{ resource: "gems", amount: 330 }] });
    });

    it("через 49 часов — позиции нет, заказ 404; за минуту до конца — ещё продаётся", async () => {
      const me = await player();
      const win = new Date(Date.UTC(2026, 10, 10, 12));
      await run(me.accountId, win);

      const last = new Date(win.getTime() + 47 * HOUR + 59 * 60_000);
      expect(skus(await shop.view(me, last))).toContain("keeper_set");
      expect(await shop.order(me, "keeper_set", last)).toMatchObject({ sku: "keeper_set", status: "pending", priceStars: 250 });

      const late = new Date(win.getTime() + 49 * HOUR);
      expect(skus(await shop.view(me, late))).not.toContain("keeper_set");
      await expect(shop.order(me, "keeper_set", late)).rejects.toMatchObject({ code: "shop_sku_not_found" });
    });

    it("вторая победа окно не продлевает: срок считается от самой ранней", async () => {
      const me = await player();
      const first = new Date(Date.UTC(2026, 10, 10, 12));
      await run(me.accountId, first);
      await run(me.accountId, new Date(first.getTime() + 30 * HOUR));

      expect((await shop.view(me, new Date(first.getTime() + 10 * HOUR))).items[0]).toMatchObject({ sku: "keeper_set", until: new Date(first.getTime() + 48 * HOUR) });
      expect(skus(await shop.view(me, new Date(first.getTime() + 49 * HOUR)))).not.toContain("keeper_set");
    });

    it("победой не считаются: стражу не победил, подозрительный и отклонённый вердикт, читы, аннулированный разбором забег", async () => {
      const me = await player();
      const at = new Date(Date.UTC(2026, 10, 10, 12));
      await run(me.accountId, at, { clearedSec: null });
      await run(me.accountId, at, { reached: false, clearedSec: null });
      await run(me.accountId, at, { verdict: "suspicious" });
      await run(me.accountId, at, { verdict: "rejected" });
      await run(me.accountId, at, { cheats: true });
      await run(me.accountId, at, { review: "annulled" });
      expect(skus(await shop.view(me, at))).not.toContain("keeper_set");

      // Разбор признал забег честным — это победа; сразу после аннулированного окно считается от неё.
      const later = new Date(at.getTime() + 5 * HOUR);
      await run(me.accountId, later, { review: "honest" });
      expect((await shop.view(me, later)).items[0]).toMatchObject({ sku: "keeper_set", until: new Date(later.getTime() + 48 * HOUR) });
    });

    it("победа соседа окна не открывает; незаконченный забег — не победа", async () => {
      const me = await player();
      const other = await player();
      await run(other.accountId, new Date());
      await prisma.run.create({ data: { runId: randomUUID(), accountId: me.accountId, status: "started", difficulty: "hard", startingWeaponId: "spark", contentHash: "h", startedAt: new Date(), rubezhReached: true, rubezhClearedSec: 650, verdict: "ok" } });

      expect(skus(await shop.view(me))).not.toContain("keeper_set");
      await expect(shop.order(me, "keeper_set")).rejects.toMatchObject({ code: "shop_sku_not_found" });
    });
  });

  describe("покупка и выдача", () => {
    it("оплата: +330 самоцветов и окрас dawn в `GET /appearance` (held), строка выдачи с покупкой", async () => {
      const me = await player();
      await run(me.accountId, new Date(Date.now() - HOUR));
      const before = (await wallet.balances(me.accountId)).gems;
      expect((await appearance.viewFor(me.accountId)).items.find((item) => item.id === "dawn")).toMatchObject({ held: false, source: { kind: "purchase", sku: "keeper_set" } });

      const invoice = await shop.order(me, "keeper_set");
      await pay(me, invoice.purchaseId);

      expect((await wallet.balances(me.accountId)).gems).toBe(before + 330);
      expect(await grantRows(me.accountId)).toEqual([{ appearance_id: "dawn", source: "purchase", purchase_id: invoice.purchaseId }]);
      expect((await appearance.viewFor(me.accountId)).items.find((item) => item.id === "dawn")).toMatchObject({ held: true, archetype: "keeper", rarity: "rare" });
      expect((await prisma.purchase.findUniqueOrThrow({ where: { purchaseId: invoice.purchaseId } })).fulfilledAt).not.toBeNull();
    });

    it("повтор подтверждения и повтор задания выдачи — без второго начисления и без второй строки", async () => {
      const me = await player();
      await run(me.accountId, new Date(Date.now() - HOUR));
      const before = (await wallet.balances(me.accountId)).gems;
      const invoice = await shop.order(me, "keeper_set");

      const same = chargeId("same");
      await pay(me, invoice.purchaseId, same);
      await pay(me, invoice.purchaseId, same);
      const stored = await prisma.purchase.findUniqueOrThrow({ where: { purchaseId: invoice.purchaseId } });
      await shop.fulfill(stored);
      await shop.fulfill(stored);

      expect((await wallet.balances(me.accountId)).gems).toBe(before + 330);
      expect(await grantRows(me.accountId)).toHaveLength(1);
    });

    it("два задания выдачи разом — одно начисление и одна строка (гонка)", async () => {
      const me = await player();
      await run(me.accountId, new Date(Date.now() - HOUR));
      const before = (await wallet.balances(me.accountId)).gems;
      const invoice = await shop.order(me, "keeper_set");
      await prisma.purchase.update({ where: { purchaseId: invoice.purchaseId }, data: { status: "paid", paidAt: new Date(), telegramChargeId: `race-${invoice.purchaseId}` } });
      const stored = await prisma.purchase.findUniqueOrThrow({ where: { purchaseId: invoice.purchaseId } });

      await Promise.all(Array.from({ length: 6 }, () => shop.fulfill(stored)));

      expect((await wallet.balances(me.accountId)).gems).toBe(before + 330);
      expect(await grantRows(me.accountId)).toHaveLength(1);
    });

    it("несколько заказов разом — одна покупка; после оплаты набор в витрине не виден, повторный заказ — «оплачено»", async () => {
      const me = await player();
      await run(me.accountId, new Date(Date.now() - HOUR));

      const invoices = await Promise.all(Array.from({ length: 5 }, () => shop.order(me, "keeper_set")));
      expect(new Set(invoices.map((invoice) => invoice.purchaseId)).size).toBe(1);
      expect(await purchaseCount(me.accountId)).toBe(1);

      await pay(me, invoices[0]?.purchaseId ?? "");
      expect(skus(await shop.view(me))).not.toContain("keeper_set");
      expect(await shop.order(me, "keeper_set")).toMatchObject({ purchaseId: invoices[0]?.purchaseId, status: "paid", invoiceUrl: null });
      expect(await purchaseCount(me.accountId)).toBe(1);
    });

    it("счёт выставлен в окне, оплата пришла после его конца — выдача идёт", async () => {
      const me = await player();
      const win = new Date(Date.now() - 47 * HOUR - 50 * 60_000);
      await run(me.accountId, win);
      const invoice = await shop.order(me, "keeper_set");
      // Окно закрылось, пока игрок решался: победа «отъехала» в прошлое.
      await prisma.run.updateMany({ where: { accountId: me.accountId }, data: { finishedAt: new Date(Date.now() - 60 * HOUR) } });
      expect(skus(await shop.view(me))).not.toContain("keeper_set");

      await pay(me, invoice.purchaseId);

      expect(await grantRows(me.accountId)).toHaveLength(1);
    });
  });

  describe("возврат", () => {
    it("самоцветы списываются по правилам возврата, строка окраса удаляется; надетый dawn — действующим станет keeper", async () => {
      const me = await player();
      await run(me.accountId, new Date(Date.now() - HOUR));
      const before = (await wallet.balances(me.accountId)).gems;
      const invoice = await shop.order(me, "keeper_set");
      const charge = chargeId("refund");
      await pay(me, invoice.purchaseId, charge);
      await appearance.choose(me.accountId, { id: "dawn" });
      expect(await appearance.viewFor(me.accountId)).toMatchObject({ selected: "dawn", effective: "dawn" });

      await confirmation.refunded(charge, Date.now());

      expect((await wallet.balances(me.accountId)).gems).toBe(before);
      expect(await grantRows(me.accountId)).toEqual([]);
      const view = await appearance.viewFor(me.accountId);
      expect(view.items.find((item) => item.id === "dawn")?.held).toBe(false);
      // Выбор не стирается, но действует Хранитель, пока владение не вернётся.
      expect(view).toMatchObject({ selected: "dawn", effective: "keeper" });
    });

    it("потраченные самоцветы не возвращаются: списывается остаток, а окрас снимается всё равно", async () => {
      const me = await player();
      await run(me.accountId, new Date(Date.now() - HOUR));
      const invoice = await shop.order(me, "keeper_set");
      const charge = chargeId("spent");
      await pay(me, invoice.purchaseId, charge);
      await prisma.$executeRaw`UPDATE wallet_balance SET balance = 30 WHERE account_id = ${me.accountId}::uuid AND resource = 'gems'::"WalletResource"`;

      await confirmation.refunded(charge, Date.now());

      expect((await wallet.balances(me.accountId)).gems).toBe(0);
      expect(await grantRows(me.accountId)).toEqual([]);
    });

    it("повтор обработки возврата ничего не меняет; выдача соседа на месте", async () => {
      const me = await player();
      const neighbour = await player();
      for (const account of [me, neighbour]) await run(account.accountId, new Date(Date.now() - HOUR));
      const mine = await shop.order(me, "keeper_set");
      const theirs = await shop.order(neighbour, "keeper_set");
      const charge = chargeId("mine");
      await pay(me, mine.purchaseId, charge);
      await pay(neighbour, theirs.purchaseId, chargeId("theirs"));

      await confirmation.refunded(charge, Date.now());
      await confirmation.refunded(charge, Date.now());

      expect(await grantRows(me.accountId)).toEqual([]);
      expect(await grantRows(neighbour.accountId)).toHaveLength(1);
    });
  });

  describe("таблица выдач", () => {
    it("выдача облика, которого нет в аккаунте, ключ `(аккаунт, облик)` и купленный облик без покупки база не примет", async () => {
      const me = await player();
      await expect(prisma.$executeRaw`INSERT INTO appearance_grant (account_id, appearance_id, source) VALUES (${randomUUID()}::uuid, 'dawn', 'purchase')`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO appearance_grant (account_id, appearance_id, source) VALUES (${me.accountId}::uuid, 'dawn', 'purchase')`).rejects.toThrow();
      const purchaseId = randomUUID();
      await prisma.purchase.create({
        data: { purchaseId, accountId: me.accountId, product: "shop_item", sku: "keeper_set", onceKey: `keeper_set:${me.accountId}`, priceStars: 250, chargedStars: 250, mode: "live", status: "paid", invoicedAt: new Date(), paidAt: new Date(), telegramChargeId: `t-${purchaseId}` },
      });
      await prisma.$executeRaw`INSERT INTO appearance_grant (account_id, appearance_id, source, purchase_id) VALUES (${me.accountId}::uuid, 'dawn', 'purchase', ${purchaseId}::uuid)`;
      await expect(prisma.$executeRaw`INSERT INTO appearance_grant (account_id, appearance_id, source, purchase_id) VALUES (${me.accountId}::uuid, 'dawn', 'purchase', ${purchaseId}::uuid)`).rejects.toThrow();
      // Покупку, на которую ссылается выдача, не стереть: журнал покупок не стирается никогда.
      await expect(prisma.purchase.delete({ where: { purchaseId } })).rejects.toThrow();
    });

    it("облики списка аккаунтов — одним запросом, без строк у тех, у кого выдач нет", async () => {
      const grants = new PrismaAppearanceGrantsRepository(prisma);
      const a = await player();
      const b = await player();
      const c = await player();
      for (const account of [a, b]) await run(account.accountId, new Date(Date.now() - HOUR));
      for (const account of [a, b]) await pay(account, (await shop.order(account, "keeper_set")).purchaseId);

      const held = await grants.held([a.accountId, b.accountId, c.accountId]);

      expect([...held.keys()].sort()).toEqual([a.accountId, b.accountId].sort());
      expect(held.get(a.accountId)).toEqual(new Set(["dawn"]));
      expect(await grants.held([])).toEqual(new Map());
    });
  });

  describe("по HTTP", () => {
    let app: NestFastifyApplication | null = null;

    afterEach(async () => {
      await app?.close();
      app = null;
    });

    async function boot(): Promise<NestFastifyApplication> {
      @Module({
        controllers: [ShopController, AppearanceController],
        providers: [
          { provide: APP_CONFIG, useValue: config },
          { provide: REDIS, useValue: redis },
          // Не сам сервис: Nest позвал бы его `onModuleInit` второй раз, а отзыв и выдача уже зарегистрированы.
          { provide: ShopService, useValue: { view: async (account: AccountRef) => await shop.view(account), order: async (account: AccountRef, sku: string) => await shop.order(account, sku) } },
          { provide: ShowcaseService, useValue: {} },
          { provide: AppearanceService, useValue: appearance },
          RateLimiter,
          AuthGuard,
        ],
      })
      class TestModule {}
      const created = await createHttpApp(TestModule, { logger: false });
      await created.init();
      await created.getHttpAdapter().getInstance().ready();
      app = created;
      return created;
    }

    async function headersOf(me: AccountRef): Promise<Record<string, string>> {
      const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      return { authorization: `Bearer ${token}` };
    }

    it("витрина, заказ, облики: набор виден со сроком, куплен, окрас — `held: true`, выбор принят", async () => {
      const http = await boot();
      const me = await player();
      const headers = await headersOf(me);
      const closed = await http.inject({ method: "POST", url: "/api/v1/shop/orders", headers, payload: { sku: "keeper_set" } });
      expect(closed.statusCode).toBe(404);
      expect(closed.json<{ error: { code: string } }>().error.code).toBe("shop_sku_not_found");

      const win = new Date(Date.now() - HOUR);
      await run(me.accountId, win);
      const view = await http.inject({ method: "GET", url: "/api/v1/shop", headers });
      const item = view.json<{ data: ShopView }>().data.items[0];
      expect(item).toMatchObject({ sku: "keeper_set", appearance: "dawn", fullStars: null, until: new Date(win.getTime() + 48 * HOUR).toISOString() });

      const order = await http.inject({ method: "POST", url: "/api/v1/shop/orders", headers, payload: { sku: "keeper_set" } });
      expect(order.statusCode).toBe(200);
      const purchaseId = order.json<{ data: { purchaseId: string } }>().data.purchaseId;
      await pay(me, purchaseId);

      const mine = await http.inject({ method: "GET", url: "/api/v1/appearance", headers });
      expect(mine.json<{ data: AppearanceView }>().data.items.find((entry) => entry.id === "dawn")).toMatchObject({ held: true });
      const put = await http.inject({ method: "PUT", url: "/api/v1/appearance", headers, payload: { id: "dawn" } });
      expect(put.statusCode).toBe(200);
      expect(put.json<{ data: AppearanceChoice }>().data).toMatchObject({ selected: "dawn", effective: "dawn" });
      expect(stars.sent.at(-1)).toMatchObject({ payload: purchaseId, stars: 250, title: "Набор хранителя" });
    });
  });
});
