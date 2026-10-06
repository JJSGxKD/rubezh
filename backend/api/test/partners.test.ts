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
import { AdminPartnersController } from "../src/modules/admin/admin-partners.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { partnerInputSchema, withinBindWindow } from "../src/modules/partners/partner-rules.js";
import { PartnersService } from "../src/modules/partners/partners.service.js";
import { ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryPartnersRepository } from "./helpers/memory-partners.js";
import { MemoryPromoCodesRepository } from "./helpers/memory-promo-codes.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2): смотрят те, кто
 * ведёт привлечение и деньги, заводят и правят — привлечение; каждое
 * изменение — в аудит; карточка показывает, что партнёр принёс.
 */

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 2, 9));
const OWNER_ID = "777000444";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

function setup(config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv)) {
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const promo = new MemoryPromoCodesRepository();
  const repository = new MemoryPartnersRepository(promo);
  const service = new PartnersService(repository, new RolesService(config, roles, accounts));
  return { accounts, roles, promo, repository, service };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role?: "admin" | "marketer" | "finance" | "moderator" | "game_designer"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

describe("правила партнёров", () => {
  it("смотрят владелец, администратор, маркетолог и бухгалтерия; правят — без бухгалтерии", () => {
    const holders = (permission: string) =>
      Object.entries(ROLE_PERMISSIONS)
        .filter(([, permissions]) => (permissions as readonly string[]).includes(permission))
        .map(([role]) => role)
        .sort();
    expect(holders("partners.view")).toEqual(["admin", "finance", "marketer", "owner"]);
    expect(holders("partners.edit")).toEqual(["admin", "marketer", "owner"]);
  });

  it("окно привязки — неделя с регистрации включительно; форма — имя обязательно, пустое — null", () => {
    expect(withinBindWindow(new Date(NOW.getTime() - 7 * DAY), NOW)).toBe(true);
    expect(withinBindWindow(new Date(NOW.getTime() - 7 * DAY - 1), NOW)).toBe(false);
    expect(partnerInputSchema.parse({ name: "  Канал  ", contact: "", note: " " })).toEqual({ name: "Канал", contact: null, note: null });
    for (const bad of [{ name: "К", contact: null, note: null }, { name: "Канал", contact: "x".repeat(121), note: null }, { name: "Канал", contact: null, note: null, extra: 1 }]) {
      expect(partnerInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("партнёры в панели", () => {
  it("маркетолог заводит и правит с аудитом; бухгалтерия только смотрит; модератору — ничего", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "100", "marketer");
    const created = await ctx.service.create(marketer, { name: "Канал «Игровой угол»", contact: "@corner", note: null }, NOW);
    expect(created).toMatchObject({ name: "Канал «Игровой угол»", stats: { bound: 0, codes: 0 } });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "partner.create", target: created.partnerId });

    const updated = await ctx.service.update(marketer, created.partnerId, { name: "Игровой угол", contact: "@corner", note: "договор до декабря" }, NOW);
    expect(updated).toMatchObject({ name: "Игровой угол", note: "договор до декабря" });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "partner.update", before: { name: "Канал «Игровой угол»" }, after: { name: "Игровой угол" } });
    expect(await codeOf(ctx.service.update(marketer, randomUUID(), { name: "Нет такого", contact: null, note: null }, NOW))).toBe("partner_not_found");

    const finance = await person(ctx, "200", "finance");
    expect((await ctx.service.catalog(finance, NOW)).partners).toHaveLength(1);
    expect(await codeOf(ctx.service.create(finance, { name: "Ещё", contact: null, note: null }, NOW))).toBe("forbidden");
    const moderator = await person(ctx, "300", "moderator");
    expect(await codeOf(ctx.service.catalog(moderator, NOW))).toBe("forbidden");
  });

  it("карточка: что принёс — привязки по дням, коды с состоянием и привязанными ими игроками", async () => {
    const ctx = setup();
    const admin = await person(ctx, "400", "admin");
    const partner = await ctx.service.create(admin, { name: "Блогер", contact: null, note: null }, NOW);
    const base = { title: "Код блогера", kind: "shared" as const, reward: { coins: 100, gems: 0, shard_common: 0, shard_uncommon: 0 }, message: null, maxRedemptions: null, newPlayersDays: null, platforms: [], note: null, partnerId: partner.partnerId, createdBy: admin.accountId, createdAt: NOW };
    await ctx.promo.create({ ...base, campaignId: "11111111-1111-4111-8111-111111111111", startsAt: new Date(NOW.getTime() - DAY), endsAt: null }, [{ code: "BLOG1", display: "BLOG1" }], null);
    await ctx.promo.create({ ...base, title: "Будущий", campaignId: "22222222-2222-4222-8222-222222222222", startsAt: new Date(NOW.getTime() + DAY), endsAt: null }, [{ code: "BLOG2", display: "BLOG2" }], null);
    for (const accountId of ["a", "b"]) {
      await ctx.promo.redeem({ campaignId: "11111111-1111-4111-8111-111111111111", accountId, code: "BLOG1", batch: false, partnerId: partner.partnerId, at: NOW });
    }
    ctx.repository.outcomes.set(partner.partnerId, { played: 1, payers: 1, stars: 250 });

    const detail = await ctx.service.detail(admin, partner.partnerId, NOW);
    expect(detail.partner.stats).toEqual({ codes: 2, activeCodes: 1, redeemed: 2, bound: 2, played: 1, payers: 1, stars: 250 });
    expect(detail.daily).toEqual([{ day: "2026-10-02", count: 2 }]);
    expect(detail.codes.map((code) => [code.title, code.state, code.bound])).toEqual(
      expect.arrayContaining([
        ["Код блогера", "active", 2],
        ["Будущий", "scheduled", 0],
      ]),
    );
    expect(detail.rules.bindWindowDays).toBe(7);
    expect(await codeOf(ctx.service.detail(admin, randomUUID(), NOW))).toBe("partner_not_found");
  });
});

describe("партнёры по HTTP панели", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("список, заведение, правка и карточка; мусор — 400, без заголовка панели — 403, кривой id — 400", async () => {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup(cfg);
    @Module({
      controllers: [AdminSessionController, AdminPartnersController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: PartnersService, useValue: ctx.service },
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
    const base = "/api/v1/admin/partners";
    const payload = { name: "Канал", contact: "@channel", note: null };

    expect((await app.inject({ method: "GET", url: base, headers })).json<{ data: { partners: unknown[] } }>().data.partners).toEqual([]);
    expect((await app.inject({ method: "POST", url: base, headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: base, headers, payload: { ...payload, name: "" } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: base, headers, payload });
    expect(created.statusCode).toBe(201);
    const partnerId = created.json<{ data: { partnerId: string } }>().data.partnerId;

    const updated = await app.inject({ method: "POST", url: `${base}/${partnerId}`, headers, payload: { ...payload, name: "Канал 2" } });
    expect(updated.json<{ data: { name: string } }>().data.name).toBe("Канал 2");
    const detail = await app.inject({ method: "GET", url: `${base}/${partnerId}`, headers });
    expect(detail.json<{ data: { partner: { name: string }; codes: unknown[] } }>().data).toMatchObject({ partner: { name: "Канал 2" }, codes: [] });
    expect((await app.inject({ method: "GET", url: `${base}/не-uuid`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/${randomUUID()}`, headers })).statusCode).toBe(404);
  });
});
