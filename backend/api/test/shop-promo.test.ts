import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { AdminShopController } from "../src/modules/admin/admin-shop.controller.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SHOP_SKUS } from "../src/modules/shop/shop-catalog.js";
import {
  PROMO_LIMITS,
  effectiveEnd,
  promoInputSchema,
  promoOffer,
  promoPrice,
  promoProblem,
  promoState,
  shownPercent,
  type PromoRow,
} from "../src/modules/shop/shop-promo-rules.js";
import { ShopPromoService } from "../src/modules/shop/shop-promo.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryShopPromoRepository } from "./helpers/memory-shop-promos.js";

/**
 * Акции магазина (docs/35-stage4-plan.md WP10, часть 8): скидка только от
 * настоящей цены каталога, на срок и с отдыхом между акциями товара; заводят
 * и снимают в панели под своим правом, с аудитом.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 1, 9));
const OWNER_ID = "777000111";

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function row(patch: Partial<PromoRow> = {}): PromoRow {
  return { promoId: randomUUID(), sku: "gems_330", percent: 20, startsAt: at(0), endsAt: at(DAY), title: null, createdAt: at(0), createdBy: randomUUID(), cancelledAt: null, cancelledBy: null, ...patch };
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

describe("правила честной скидки", () => {
  it("цена вниз до целой звезды, но не ниже одной; ярлык — фактическая скидка вниз, не больше списанной", () => {
    expect(promoPrice(250, 30)).toBe(175);
    expect(promoPrice(50, 33)).toBe(33);
    expect(promoPrice(1, 80)).toBe(1);
    expect(shownPercent(50, 33)).toBe(34);
    expect(shownPercent(50, 50)).toBe(0);
    for (const full of [1, 2, 7, 50, 99, 250, 500, 10_000]) {
      for (let percent = PROMO_LIMITS.minPercent; percent <= PROMO_LIMITS.maxPercent; percent++) {
        const offer = promoOffer(full, { percent });
        if (offer === null) continue;
        expect(offer.price, `${String(full)} −${String(percent)}%`).toBeLessThan(full);
        // Меньше заявленной скидка бывает, только когда цена упёрлась в одну звезду, — и ярлык тогда честно меньше.
        if (offer.price > 1) expect(offer.percent, `${String(full)} −${String(percent)}%`).toBeGreaterThanOrEqual(percent);
        // Ярлык не обещает больше списанного: скидка ярлыка не больше фактической.
        expect(full - offer.price, `${String(full)} −${String(percent)}%`).toBeGreaterThanOrEqual((full * offer.percent) / 100);
      }
    }
  });

  it("скидки не вышло — нет и акции: товар за звезду, площадка без цены, акции нет", () => {
    expect(promoOffer(1, { percent: 50 })).toBeNull();
    expect(promoOffer(null, { percent: 50 })).toBeNull();
    expect(promoOffer(250, undefined)).toBeNull();
  });

  it("фактический конец: снятая посреди — в момент снятия, снятая до начала не шла вовсе", () => {
    expect(effectiveEnd(row())).toEqual(at(DAY));
    expect(effectiveEnd(row({ cancelledAt: at(HOUR) }))).toEqual(at(HOUR));
    expect(effectiveEnd(row({ startsAt: at(HOUR), cancelledAt: at(0) }))).toBeNull();
    expect(effectiveEnd(row({ cancelledAt: at(2 * DAY) }))).toEqual(at(DAY));
  });

  it("состояние для панели: будущая, идёт, кончилась, снята", () => {
    expect(promoState(row({ startsAt: at(HOUR) }), NOW)).toBe("scheduled");
    expect(promoState(row(), at(HOUR))).toBe("active");
    expect(promoState(row(), at(DAY))).toBe("ended");
    expect(promoState(row({ cancelledAt: at(HOUR) }), at(2 * HOUR))).toBe("cancelled");
    expect(promoState(row({ startsAt: at(HOUR), cancelledAt: at(0) }), at(0))).toBe("cancelled");
  });

  it("срок: не в прошлом, не дальше чем за 60 дней, от часа до 14 дней", () => {
    const problem = (startsAt: Date, endsAt: Date) => promoProblem({ startsAt, endsAt }, [], NOW)?.code ?? null;
    expect(problem(at(0), at(DAY))).toBeNull();
    // «Начать сейчас» из панели доходит с задержкой — пара минут не в счёт.
    expect(problem(at(-2 * 60_000), at(DAY))).toBeNull();
    expect(problem(at(-HOUR), at(DAY))).toBe("promo_period");
    expect(problem(at(61 * DAY), at(62 * DAY))).toBe("promo_period");
    expect(problem(at(0), at(HOUR - 1))).toBe("promo_period");
    expect(problem(at(0), at(PROMO_LIMITS.maxDays * DAY))).toBeNull();
    expect(problem(at(0), at(PROMO_LIMITS.maxDays * DAY + 1))).toBe("promo_period");
  });

  it("между акциями товара полная цена стоит 14 дней: впритык — можно, на минуту раньше — нет; снятая до начала не мешает", () => {
    const earlier = row({ startsAt: at(-3 * DAY), endsAt: at(-DAY) });
    const restEnd = earlier.endsAt.getTime() + PROMO_LIMITS.restDays * DAY;
    expect(promoProblem({ startsAt: new Date(restEnd), endsAt: new Date(restEnd + DAY) }, [earlier], NOW)).toBeNull();
    expect(promoProblem({ startsAt: new Date(restEnd - 60_000), endsAt: new Date(restEnd + DAY) }, [earlier], NOW)?.code).toBe("promo_overlap");
    // Будущая акция мешает и раньше себя: после новой до неё тоже 14 дней.
    const later = row({ startsAt: at(20 * DAY), endsAt: at(21 * DAY) });
    expect(promoProblem({ startsAt: at(0), endsAt: at(7 * DAY) }, [later], NOW)?.code).toBe("promo_overlap");
    expect(promoProblem({ startsAt: at(0), endsAt: at(6 * DAY) }, [later], NOW)).toBeNull();
    // Снятая посреди считается до снятия; снятая до начала — будто её не было.
    expect(promoProblem({ startsAt: at(0), endsAt: at(DAY) }, [row({ startsAt: at(-20 * DAY), endsAt: at(-10 * DAY), cancelledAt: at(-15 * DAY) })], NOW)).toBeNull();
    expect(promoProblem({ startsAt: at(0), endsAt: at(DAY) }, [row({ startsAt: at(HOUR), endsAt: at(DAY), cancelledAt: at(0) })], NOW)).toBeNull();
  });

  it("схема: процент в пределах, лишнее поле — отказ, пустая подпись — без подписи", () => {
    const base = { sku: "gems_330", percent: 20, startsAt: at(0).toISOString(), endsAt: at(DAY).toISOString(), title: "  " };
    expect(promoInputSchema.parse(base).title).toBeNull();
    expect(promoInputSchema.parse({ ...base, title: " Неделя самоцветов " }).title).toBe("Неделя самоцветов");
    for (const bad of [
      { ...base, percent: PROMO_LIMITS.minPercent - 1 },
      { ...base, percent: PROMO_LIMITS.maxPercent + 1 },
      { ...base, percent: 12.5 },
      { ...base, startsAt: "завтра" },
      { ...base, oldStars: 999 },
      { ...base, title: "я".repeat(49) },
    ]) {
      expect(promoInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

function setup(config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv)) {
  const repository = new MemoryShopPromoRepository();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const service = new ShopPromoService(repository, new RolesService(config, roles, accounts));
  return { repository, accounts, roles, service };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role?: "admin" | "marketer" | "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

function input(patch: Partial<{ sku: string; percent: number; startsAt: Date; endsAt: Date; title: string | null }> = {}) {
  return { sku: "gems_330", percent: 25, startsAt: at(0), endsAt: at(3 * DAY), title: null, ...patch };
}

describe("акции в панели", () => {
  it("право — у владельца, администратора и маркетолога; цену каталога правят не они, а через «sku.price.*»", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes("shop.promo.edit"))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["admin", "marketer", "owner"]);
  });

  it("маркетолог заводит и снимает акцию с аудитом; геймдизайнеру и модератору — 403", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "100", "marketer");
    const created = await ctx.service.create(marketer, input({ title: "Неделя самоцветов" }), NOW);
    expect(created).toMatchObject({ sku: "gems_330", percent: 25, title: "Неделя самоцветов", state: "active", createdBy: marketer.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: marketer.accountId, action: "shop.promo.create", target: created.promoId });

    const cancelled = await ctx.service.cancel(marketer, created.promoId, at(HOUR));
    expect(cancelled).toMatchObject({ state: "cancelled", cancelledBy: marketer.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "shop.promo.cancel", target: created.promoId });
    // Повторно снимать нечего.
    expect(await codeOf(ctx.service.cancel(marketer, created.promoId, at(2 * HOUR)))).toBe("promo_not_found");

    for (const role of ["game_designer", "moderator"] as const) {
      const outsider = await person(ctx, `2${role}`, role);
      expect(await codeOf(ctx.service.create(outsider, input({ sku: "gems_60" }), NOW)), role).toBe("forbidden");
      expect(await codeOf(ctx.service.catalog(outsider, NOW)), role).toBe("forbidden");
    }
  });

  it("неизвестный товар — 404; рядом другая акция — 409 с объяснением; соседний товар — можно", async () => {
    const ctx = setup();
    const admin = await person(ctx, "300", "admin");
    expect(await codeOf(ctx.service.create(admin, input({ sku: "chest_epic" }), NOW))).toBe("shop_sku_not_found");
    await ctx.service.create(admin, input(), NOW);
    expect(await codeOf(ctx.service.create(admin, input({ startsAt: at(10 * DAY), endsAt: at(11 * DAY) }), NOW))).toBe("promo_overlap");
    expect(await codeOf(ctx.service.create(admin, input({ startsAt: at(-DAY) }), NOW))).toBe("promo_period");
    await ctx.service.create(admin, input({ sku: "gems_700" }), NOW);
    expect(ctx.repository.rows).toHaveLength(2);
  });

  it("список для панели — с состоянием и товарами с ценой каталога для предпросмотра", async () => {
    const ctx = setup();
    const admin = await person(ctx, "400", "admin");
    ctx.repository.seed({ sku: "gems_60", percent: 10, startsAt: at(-20 * DAY), endsAt: at(-19 * DAY) });
    ctx.repository.seed({ sku: "gems_330", percent: 20, startsAt: at(-HOUR), endsAt: at(HOUR) });
    ctx.repository.seed({ sku: "gems_700", percent: 30, startsAt: at(DAY), endsAt: at(2 * DAY) });
    const view = await ctx.service.catalog(admin, NOW);
    expect(view.promos.map((promo) => [promo.sku, promo.state])).toEqual([
      ["gems_700", "scheduled"],
      ["gems_330", "active"],
      ["gems_60", "ended"],
    ]);
    expect(view.skus.map((sku) => sku.sku).sort()).toEqual(SHOP_SKUS.map((sku) => sku.id).sort());
    expect(view.skus.find((sku) => sku.sku === "gems_330")?.stars).toBe(250);
    expect(view.limits).toEqual(PROMO_LIMITS);
  });

  it("идущие акции — из памяти полминуты; заведённая или снятая в панели видна сразу на этой реплике", async () => {
    const ctx = setup();
    const admin = await person(ctx, "500", "admin");
    expect((await ctx.service.active(NOW)).size).toBe(0);
    expect((await ctx.service.active(at(1_000))).size).toBe(0);
    expect(ctx.repository.currentCalls).toBe(1);

    const created = await ctx.service.create(admin, input(), at(2_000));
    expect((await ctx.service.active(at(3_000))).get("gems_330")?.promoId).toBe(created.promoId);
    await ctx.service.cancel(admin, created.promoId, at(4_000));
    expect((await ctx.service.active(at(5_000))).size).toBe(0);
  });

  it("акция, начинающаяся внутри полуминуты кэша, начинается вовремя, а кончившаяся — уходит вовремя", async () => {
    const ctx = setup();
    ctx.repository.seed({ sku: "gems_330", percent: 20, startsAt: at(10_000), endsAt: at(HOUR) });
    ctx.repository.seed({ sku: "gems_60", percent: 20, startsAt: at(-HOUR), endsAt: at(20_000) });
    expect([...(await ctx.service.active(NOW)).keys()]).toEqual(["gems_60"]);
    expect([...(await ctx.service.active(at(25_000))).keys()]).toEqual(["gems_330"]);
    expect(ctx.repository.currentCalls).toBe(1);
  });
});

describe("акции по HTTP панели", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("владелец видит список, заводит и снимает; мусор — 400, без заголовка панели — 403", async () => {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup(cfg);
    @Module({
      controllers: [AdminSessionController, AdminShopController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: ShopPromoService, useValue: ctx.service },
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

    const login = await app.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const now = Date.now();
    const payload = { sku: "gems_330", percent: 30, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3 * DAY).toISOString(), title: "Неделя самоцветов" };

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/shop/promos", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: { promos: unknown[] } }>().data.promos).toEqual([]);

    expect((await app.inject({ method: "POST", url: "/api/v1/admin/shop/promos", headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/shop/promos", headers, payload: { ...payload, percent: 95 } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/shop/promos", headers, payload });
    expect(created.statusCode).toBe(201);
    const promoId = created.json<{ data: { promoId: string; state: string } }>().data.promoId;
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/shop/promos", headers, payload })).statusCode).toBe(409);

    expect((await app.inject({ method: "POST", url: "/api/v1/admin/shop/promos/не-uuid/cancel", headers })).statusCode).toBe(400);
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/admin/shop/promos/${promoId}/cancel`, headers });
    expect(cancelled.statusCode).toBe(201);
    expect(cancelled.json<{ data: { state: string } }>().data.state).toBe("cancelled");
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/shop/promos/${randomUUID()}/cancel`, headers })).statusCode).toBe(404);
  });
});
