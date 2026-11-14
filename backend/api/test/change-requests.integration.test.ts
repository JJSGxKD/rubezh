import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminChangeRequestsController } from "../src/modules/admin/admin-change-requests.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY, PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { ChangeKindRegistry } from "../src/modules/change-requests/change-request-kinds.js";
import { PrismaChangeRequestsRepository } from "../src/modules/change-requests/change-requests.repository.js";
import { ChangeRequestsService } from "../src/modules/change-requests/change-requests.service.js";
import type { ChangeRequestsNotifier } from "../src/modules/change-requests/change-requests-notifier.js";
import { SkuPriceKind } from "../src/modules/change-requests/sku-price.kind.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { ItemsService } from "../src/modules/items/items.service.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import type { ShopChoice } from "../src/modules/shop/shop-choice.js";
import { ShopPromoService } from "../src/modules/shop/shop-promo.service.js";
import { PrismaShopOverrideRepository, ShopOverrides } from "../src/modules/shop/shop-overrides.js";
import { ShopService } from "../src/modules/shop/shop.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { MemoryShopPromoRepository } from "./helpers/memory-shop-promos.js";
import { switchesOf } from "./helpers/notify-targets.js";
import { testPrisma } from "./helpers/test-prisma.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Заявки на правку цен на живом Postgres (tasks/T-0309; адрес — TEST_DATABASE_URL,
 * без него пропуск): заявка → подтверждение другим → цена товара новая; цель
 * изменилась → 409; правка с stars: 0 — отказ схемой; покупка, начатая до
 * правки, оплачивается по цене счёта; без sku.price.edit — 403; и то, что
 * держит база под гонкой: одна живая заявка на цель, одно применение.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const OWNER_ID = "777000333";
const BASE = "/api/v1/admin/change-requests";
const NOW = new Date(Date.UTC(2026, 10, 13, 9));
const HOUR = 3_600_000;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

function proposal(patch: Record<string, unknown> = {}) {
  return { kind: "sku_price", target: "gems_60", after: { stars: 60 }, reason: "Малый набор дешевле соседнего за штуку", ...patch };
}

describe.skipIf(DATABASE_URL === "")("заявки на правку цен на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaChangeRequestsRepository;
  let app: NestFastifyApplication | null = null;
  const roleAccounts: string[] = [];

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
    repository = new PrismaChangeRequestsRepository(prisma);
  });

  // Цели — настоящие товары каталога, поэтому таблицы чистятся целиком: другие тесты их не трогают.
  beforeEach(async () => {
    await prisma.changeRequest.deleteMany({ where: { OR: [{ kind: { not: "reward_setting" } }, { target: { startsWith: "gems_" } }] } });
    await prisma.shopSkuOverride.deleteMany();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  afterAll(async () => {
    await prisma.changeRequest.deleteMany({ where: { OR: [{ kind: { not: "reward_setting" } }, { target: { startsWith: "gems_" } }] } });
    await prisma.shopSkuOverride.deleteMany();
    await prisma.accountRole.deleteMany({ where: { accountId: { in: roleAccounts } } });
    await prisma.$disconnect();
  });

  function setup(config: AppConfig = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv)) {
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const overrides = new ShopOverrides(new PrismaShopOverrideRepository(prisma));
    const requested: string[] = [];
    const notifier = { requested: async (view: { requestId: string }) => void requested.push(view.requestId) } as unknown as ChangeRequestsNotifier;
    const service = new ChangeRequestsService(repository, accounts, new RolesService(config, roles, accounts), new ChangeKindRegistry([new SkuPriceKind(overrides)]), notifier);
    return { config, accounts, roles, overrides, service, requested };
  }
  type Ctx = ReturnType<typeof setup>;

  async function person(ctx: Ctx, id: string, role?: "game_designer" | "moderator" | "owner"): Promise<AccountRef> {
    const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Участник ${id}`, username: null, photoUrl: null }, Date.now());
    if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: "telegram", platformUserId: id };
  }

  it("заявка → подтверждение другим человеком → цена товара новая; хранится правка поверх каталога, заявка закрыта", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    expect((await ctx.overrides.sku("gems_60"))?.stars).toBe(50);

    const view = await ctx.service.propose(author, proposal(), NOW);
    expect(view).toMatchObject({ status: "pending", before: { stars: 50 }, after: { stars: 60 } });
    // До подтверждения цена прежняя — и у кэша, и у базы.
    expect((await ctx.overrides.sku("gems_60"))?.stars).toBe(50);
    expect(await prisma.shopSkuOverride.count()).toBe(0);

    const done = await ctx.service.approve(reviewer, view.requestId, at(HOUR));
    expect(done).toMatchObject({ status: "approved", decidedBy: reviewer.accountId });
    expect((await ctx.overrides.sku("gems_60"))?.stars).toBe(60);

    const stored = await prisma.shopSkuOverride.findUnique({ where: { skuId: "gems_60" } });
    expect(stored).toMatchObject({ skuId: "gems_60", fields: { stars: 60 }, setBy: reviewer.accountId });
    expect(stored?.setAt).toEqual(at(HOUR));
    const request = await prisma.changeRequest.findUnique({ where: { requestId: view.requestId } });
    expect(request).toMatchObject({ status: "approved", decidedBy: reviewer.accountId, kind: "sku_price", target: "gems_60", author: author.accountId });
    expect(request?.decidedAt).toEqual(at(HOUR));
    expect(request?.before).toEqual({ stars: 50 });
    expect(request?.after).toEqual({ stars: 60 });

    // Другая реплика читает ту же цену из базы, а не из чужой памяти.
    expect((await new ShopOverrides(new PrismaShopOverrideRepository(prisma)).sku("gems_60"))?.stars).toBe(60);

    // Следующая правка того же товара — поверх прежней: «было» уже 60, а чужие поля правки на месте.
    const second = await ctx.service.propose(author, proposal({ after: { stars: 65, sort: 25 } }), at(2 * HOUR));
    expect(second.before).toEqual({ stars: 60, sort: 20 });
    await ctx.service.approve(reviewer, second.requestId, at(3 * HOUR));
    expect((await prisma.shopSkuOverride.findUnique({ where: { skuId: "gems_60" } }))?.fields).toEqual({ stars: 65, sort: 25 });
    expect((await prisma.shopSkuOverride.count())).toBe(1);
  });

  it("цель изменилась между заявкой и подтверждением — 409, заявка superseded, правка не применена", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const view = await ctx.service.propose(author, proposal(), NOW);

    // Цену поменяли мимо заявки — выкатом или руками в базе.
    await prisma.shopSkuOverride.create({ data: { skuId: "gems_60", fields: { stars: 55 }, setBy: randomUUID(), setAt: at(HOUR) } });
    expect(await codeOf(ctx.service.approve(reviewer, view.requestId, at(2 * HOUR)))).toBe("change_request_stale");

    expect(await prisma.changeRequest.findUnique({ where: { requestId: view.requestId } })).toMatchObject({ status: "superseded" });
    expect((await prisma.shopSkuOverride.findUnique({ where: { skuId: "gems_60" } }))?.fields).toEqual({ stars: 55 });
  });

  it("правка с stars: 0 — отказ схемой, заявки и правки в базе нет", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    expect(await codeOf(ctx.service.propose(author, proposal({ after: { stars: 0 } }), NOW))).toBe("change_request_value_invalid");
    expect(await codeOf(ctx.service.propose(author, proposal({ after: { contents: { gems: 0 } } }), NOW))).toBe("change_request_value_invalid");
    expect(await codeOf(ctx.service.propose(author, proposal({ after: { stars: 50 } }), NOW))).toBe("change_request_value_invalid");
    expect(await prisma.changeRequest.count()).toBe(0);
    expect(await prisma.shopSkuOverride.count()).toBe(0);
  });

  it("заявка старше 72 часов — expired в базе; новая заявка на ту же цель гасит прежнюю; одна живая на цель", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const old = await ctx.service.propose(author, proposal(), NOW);
    expect(await codeOf(ctx.service.approve(reviewer, old.requestId, at(72 * HOUR)))).toBe("change_request_expired");
    expect((await prisma.changeRequest.findUnique({ where: { requestId: old.requestId } }))?.status).toBe("expired");

    const first = await ctx.service.propose(author, proposal({ after: { stars: 55 } }), at(73 * HOUR));
    const second = await ctx.service.propose(reviewer, proposal({ after: { stars: 58 } }), at(74 * HOUR));
    const rows = await prisma.changeRequest.findMany({ where: { target: "gems_60" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => [row.requestId, row.status])).toEqual([
      [old.requestId, "expired"],
      [first.requestId, "superseded"],
      [second.requestId, "pending"],
    ]);

    // Просроченные в списке закрывает сама выборка — без отдельного задания.
    const lazy = await ctx.service.propose(author, proposal({ target: "gems_330", after: { stars: 240 } }), at(75 * HOUR));
    const overview = await ctx.service.overview(author, at(75 * HOUR + 72 * HOUR));
    expect(overview.requests.find((request) => request.requestId === lazy.requestId)?.status).toBe("expired");
    expect(overview.requests.find((request) => request.requestId === second.requestId)?.status).toBe("expired");
  });

  it("гонка двух подтверждений: цена применяется один раз, второй получает «закрыта»", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const one = await person(ctx, "200", "owner");
    const two = await person(ctx, "201", "game_designer");
    const view = await ctx.service.propose(author, proposal(), NOW);
    const results = await Promise.allSettled([ctx.service.approve(one, view.requestId, at(HOUR)), ctx.service.approve(two, view.requestId, at(HOUR))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason instanceof DomainError && failed.reason.code).toBe("change_request_closed");
    expect(await prisma.shopSkuOverride.count()).toBe(1);
    expect((await prisma.changeRequest.findUnique({ where: { requestId: view.requestId } }))?.status).toBe("approved");
  });

  it("гонка новых заявок на одну цель: живая остаётся одна, остальные погашены, база не нарушена", async () => {
    const ctx = setup();
    const people = await Promise.all(["100", "101", "102", "103", "104"].map((id) => person(ctx, id, "game_designer")));
    const results = await Promise.allSettled(people.map((human, index) => ctx.service.propose(human, proposal({ after: { stars: 51 + index } }), NOW)));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const rows = await prisma.changeRequest.findMany({ where: { target: "gems_60" } });
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "superseded")).toHaveLength(4);
  });

  it("подтверждение против новой заявки на ту же цель: одно из двух, живая заявка одна, цена ложится только подтверждённая", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const other = await person(ctx, "101", "game_designer");
    const view = await ctx.service.propose(author, proposal(), NOW);
    const [approved, newer] = await Promise.allSettled([ctx.service.approve(reviewer, view.requestId, at(HOUR)), ctx.service.propose(other, proposal({ after: { stars: 58 } }), at(HOUR))]);
    expect(newer.status).toBe("fulfilled");
    const rows = await prisma.changeRequest.findMany({ where: { target: "gems_60" } });
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    const override = await prisma.shopSkuOverride.findUnique({ where: { skuId: "gems_60" } });
    if (approved.status === "fulfilled") {
      // Подтверждение прошло первым: цена 60, а «было» новой заявки — уже 60.
      expect(override?.fields).toEqual({ stars: 60 });
      expect(rows.find((row) => row.requestId === view.requestId)?.status).toBe("approved");
    } else {
      expect(approved.reason).toBeInstanceOf(DomainError);
      expect(override).toBeNull();
      expect(rows.find((row) => row.requestId === view.requestId)?.status).toBe("superseded");
    }
  });

  it("база держит инварианты: вид и статус из списка, вторая живая заявка на цель не вставится", async () => {
    const insert = (kind: string, status: string, target = "gems_60") =>
      prisma.$executeRaw`INSERT INTO change_request (request_id, kind, target, before, after, reason, author, status, created_at)
        VALUES (${randomUUID()}::uuid, ${kind}, ${target}, '{}'::jsonb, '{}'::jsonb, 'причина', ${randomUUID()}::uuid, ${status}, now())`;
    await expect(insert("other_kind", "pending")).rejects.toThrow(/change_request_kind/);
    await expect(insert("sku_price", "done")).rejects.toThrow(/change_request_status/);
    await insert("sku_price", "pending");
    await expect(insert("sku_price", "pending")).rejects.toThrow(/change_request_pending/);
    // Закрытых заявок на цель сколько угодно, живая на другую цель — тоже.
    await insert("sku_price", "rejected");
    await insert("sku_price", "pending", "gems_330");
    await insert("reward_setting", "pending");
  });

  it("получатели уведомления — аккаунты с ролью, дающей право на цены; остальных нет", async () => {
    const accounts = new PrismaAccountRepository(prisma);
    const make = async (): Promise<string> => {
      const created = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Роль", username: null }, Date.now());
      roleAccounts.push(created.accountId);
      return created.accountId;
    };
    const designer = await make();
    const moderator = await make();
    await prisma.accountRole.createMany({
      data: [
        { accountId: designer, role: "game_designer" },
        { accountId: moderator, role: "moderator" },
      ],
    });
    const peers = await repository.peers(["game_designer", "owner"]);
    expect(peers).toContain(designer);
    expect(peers).not.toContain(moderator);
    expect(await repository.peers([])).toEqual([]);
  });

  describe("покупка, начатая до правки", () => {
    const settings = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true" } as NodeJS.ProcessEnv);

    class Wallet {
      readonly grants: GrantInput[] = [];
      async grant(input: GrantInput): Promise<GrantResult> {
        this.grants.push(input);
        return { credited: input.amount, balance: 0, duplicate: false };
      }
    }

    function shopOn(overrides: ShopOverrides) {
      const purchases = new MemoryPurchasesRepository();
      const api = new FakeStarsApi();
      const providers = starsProviders(api);
      const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
      const fulfillment = new PurchaseFulfillment();
      const wallet = new Wallet();
      const items = { inventory: async () => ({ equipped: {} }) };
      const reader: SettingsReader = { get: (setting) => (setting.key === SETTINGS.shopTributeUrl.key ? setting.schema.parse("") : setting.fallback), onChange: () => undefined };
      const accounts = new MemoryAccountRepository();
      const promos = new ShopPromoService(new MemoryShopPromoRepository(), new RolesService(settings, new MemoryRolesRepository(), accounts));
      const revocation = new PurchaseRevocation();
      const choice = { counts: async () => new Map() } as unknown as ShopChoice;
      const shop = new ShopService(
        payments,
        fulfillment,
        wallet as unknown as WalletService,
        items as unknown as ItemsService,
        promos,
        reader,
        revocation,
        restrictionsGate(new MemoryRestrictionsRepository()),
        choice,
        overrides,
      );
      shop.onModuleInit();
      const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), new PaymentsHooks(), revocation);
      const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers, new PurchaseRevocation()), new RunsHooks(), providers, fulfillment, purchases);
      return { purchases, api, shop, wallet, queue };
    }

    it("счёт, выставленный до правки, оплачивается по прежней цене; новый счёт — по новой, витрина показывает новую", async () => {
      const ctx = setup();
      const author = await person(ctx, "100", "game_designer");
      const reviewer = await person(ctx, "200", "owner");
      const store = shopOn(ctx.overrides);
      const me: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "555000777" };

      const before = await store.shop.order(me, "gems_60");
      expect(before).toMatchObject({ priceStars: 50, chargedStars: 50 });
      expect(store.api.sent.at(-1)).toMatchObject({ payload: before.purchaseId, stars: 50 });

      const view = await ctx.service.propose(author, proposal(), NOW);
      await ctx.service.approve(reviewer, view.requestId, at(HOUR));

      // Витрина и новые счета — по новой цене...
      expect((await store.shop.view(me)).items.find((item) => item.sku === "gems_60")).toMatchObject({ stars: 60, chargedStars: 60 });
      const after = await store.shop.order(me, "gems_60");
      expect(after).toMatchObject({ priceStars: 60, chargedStars: 60 });
      expect(store.api.sent.at(-1)).toMatchObject({ payload: after.purchaseId, stars: 60 });

      // ...а старый счёт остаётся на 50: цена берётся из счёта, а не перечитывается.
      expect(await store.purchases.byId(before.purchaseId)).toMatchObject({ priceStars: 50, chargedStars: 50 });
      const row = await store.purchases.byId(before.purchaseId);
      if (row === null) throw new Error("нет покупки");
      store.purchases.owners.set(row.accountId, me.platformUserId);
      await store.queue.process({
        data: { kind: "confirm", payment: { platform: "telegram", chargeId: `charge-${before.purchaseId}`, payload: before.purchaseId, payerId: me.platformUserId, currency: "XTR", totalAmount: 50 } },
      });
      expect(await store.purchases.byId(before.purchaseId)).toMatchObject({ status: "paid", chargedStars: 50 });
      expect(store.wallet.grants.map((grant) => [grant.resource, grant.amount])).toEqual([["gems", 60]]);
    });
  });

  describe("HTTP", () => {
    async function start() {
      const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
      const ctx = setup(cfg);
      const redis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
      @Module({
        controllers: [AdminSessionController, AdminChangeRequestsController],
        providers: [
          { provide: APP_CONFIG, useValue: cfg },
          { provide: REDIS, useValue: redis },
          { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
          { provide: ROLES_REPOSITORY, useValue: ctx.roles },
          { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
          { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
          { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
          { provide: ChangeRequestsService, useValue: ctx.service },
          PanelLoginService,
          RateLimiter,
          RolesService,
          PermissionGuard,
          AuthGuard,
          AdminSessionService,
          AdminSessionGuard,
        ],
      })
      class TestModule {}
      app = await createHttpApp(TestModule, { logger: false });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const login = async (user: string) => {
        const response = await app!.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: user } });
        return { [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE, cookie: `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? ""}` };
      };
      // Вход в панель открыт тем, у кого уже есть роль: роли выдаются до входа.
      const seat = async (devId: string, name: string, role: "game_designer" | "moderator"): Promise<Record<string, string>> => {
        const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: devId, displayName: name, username: null, photoUrl: null }, Date.now());
        await ctx.roles.grant(account.accountId, role, null);
        return await login(`${devId}:${name}`);
      };
      return { ctx, login, seat };
    }

    const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: Record<string, unknown>) =>
      app!.inject({ method, url: `${BASE}${url}`, headers, ...(payload === undefined ? {} : { payload }) });

    it("геймдизайнер подаёт, владелец подтверждает: товар получает новую цену; автору «подтвердить» и 403 без права, stars: 0 — 422", async () => {
      const { login, seat } = await start();
      const owner = await login(`dev-${OWNER_ID}:Владелец`);
      const designer = await seat("dev-player-601", "Геймдизайнер", "game_designer");
      const moderator = await seat("dev-player-602", "Модератор", "moderator");

      // Без права на цены — 403 и на чтение «sku.price.view» тоже, и на заявку.
      expect((await call("POST", "", moderator, proposal())).statusCode).toBe(403);
      expect((await call("GET", "", moderator)).statusCode).toBe(403);
      // Схема каталога — 422 с причиной словами.
      const zero = await call("POST", "", designer, proposal({ after: { stars: 0 } }));
      expect(zero.statusCode).toBe(422);
      expect(zero.json<{ error: { code: string } }>().error.code).toBe("change_request_value_invalid");
      expect(await prisma.changeRequest.count()).toBe(0);

      const created = await call("POST", "", designer, proposal());
      expect(created.statusCode).toBe(201);
      const { requestId } = created.json<{ data: { requestId: string; before: unknown; after: unknown } }>().data;
      expect((await call("POST", `/${requestId}/approve`, designer)).statusCode).toBe(403);
      expect((await call("POST", `/${requestId}/approve`, moderator)).statusCode).toBe(403);

      const approved = await call("POST", `/${requestId}/approve`, owner);
      expect(approved.statusCode).toBe(201);
      expect(approved.json<{ data: { status: string; authorName: string; decidedByName: string } }>().data).toMatchObject({ status: "approved", authorName: "Геймдизайнер", decidedByName: "Владелец" });
      expect((await prisma.shopSkuOverride.findUnique({ where: { skuId: "gems_60" } }))?.fields).toEqual({ stars: 60 });

      const overview = await call("GET", "", designer);
      const body = overview.json<{ data: { requests: { requestId: string; status: string; kind: string }[]; targets: { sku_price: { target: string; current: { stars: number }; inCode: { stars: number }; overridden: boolean }[] } } }>().data;
      // Заявки на награды (T-0310) в списке тоже есть и идут параллельным файлом: смотрим только цены.
      expect(body.requests.filter((request) => request.kind === "sku_price").map((request) => [request.requestId, request.status])).toEqual([[requestId, "approved"]]);
      expect(body.targets.sku_price.find((target) => target.target === "gems_60")).toMatchObject({ current: { stars: 60 }, inCode: { stars: 50 }, overridden: true });
    });
  });
});
