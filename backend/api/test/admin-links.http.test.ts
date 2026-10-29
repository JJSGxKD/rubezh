import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ConversionsJournal } from "../src/modules/ad-conversions/conversions-journal.service.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminLinksController } from "../src/modules/admin/admin-links.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { AutoSourcesRepository, UnknownKeyRow } from "../src/modules/links/auto-sources.repository.js";
import { newLinkCode } from "../src/modules/links/link-code.js";
import type { LinkDisplayPatch, LinkRecord, LinksRepository } from "../src/modules/links/links.repository.js";
import { LinksService } from "../src/modules/links/links.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { SecretsService } from "../src/modules/secrets/secrets.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Автоисточники в панели «Ссылки» по HTTP (T-0180, Р116): название и скрытие —
 * `PATCH /admin/links/:code/display`, сводка незнакомых ключей —
 * `GET /admin/links/unknown-keys`. Настоящие охранники панели и права, ссылки в памяти.
 */

const OWNER_ID = "777000222";
const URL_BASE = "/api/v1/admin/links";

/** Ссылки в памяти — ровно то, что нужно маршрутам названия и скрытия. */
class Links implements LinksRepository {
  readonly records = new Map<string, LinkRecord>();
  async create(): Promise<LinkRecord> {
    throw new Error("не нужно");
  }
  async byCode(code: string): Promise<LinkRecord | null> {
    return this.records.get(code) ?? null;
  }
  async setDisplay(code: string, patch: LinkDisplayPatch, now: Date): Promise<LinkRecord | null> {
    const link = this.records.get(code);
    if (link === undefined || !link.auto) return null;
    const next = { ...link };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.hidden !== undefined) next.hiddenAt = patch.hidden ? now : null;
    this.records.set(code, next);
    return next;
  }
  async recordClick(): Promise<void> {}
  async list(): Promise<never[]> {
    return [];
  }
  async partnerName(): Promise<string | null> {
    return null;
  }
  async retarget(): Promise<LinkRecord | null> {
    return null;
  }
}

class Keys implements AutoSourcesRepository {
  rows: UnknownKeyRow[] = [];
  async ensure(): Promise<"existing"> {
    return "existing";
  }
  async noteUnknownKeys(): Promise<void> {}
  async unknownKeys(): Promise<UnknownKeyRow[]> {
    return this.rows;
  }
}

function record(patch: Partial<LinkRecord> = {}): LinkRecord {
  return {
    code: newLinkCode(),
    platform: "telegram",
    campaign: "oct",
    source: "tgads",
    medium: null,
    note: null,
    createdBy: null,
    network: null,
    registrationOn: "first_run",
    target: "app",
    partner: null,
    createdAt: new Date("2026-10-20T10:00:00Z"),
    auto: true,
    autoKey: "src-tgads_cmp-oct",
    partnerTag: null,
    title: null,
    hiddenAt: null,
    ...patch,
  };
}

describe("автоисточники в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const repository = new Links();
    const keys = new Keys();
    const limit = { open: true };
    const limiter = { consume: async () => limit.open } as unknown as RateLimiter;
    const links = new LinksService(
      cfg,
      repository,
      new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]),
      new RolesService(cfg, roles, accounts),
      keys,
    );
    const journal = { summaries: async () => new Map() };
    const secrets = { get: () => null };
    @Module({
      controllers: [AdminSessionController, AdminLinksController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: LinksService, useValue: links },
        { provide: ConversionsJournal, useValue: journal },
        { provide: SecretsService, useValue: secrets },
        PanelLoginService,
        { provide: RateLimiter, useValue: limiter },
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
      return `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? ""}`;
    };
    return { accounts, roles, repository, keys, limit, login };
  }

  const headers = (cookie: string) => ({ cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });

  it("PATCH :code/display: название и скрытие автоисточника; 400 на мусор, 404 на чужой код, 403 без права", async () => {
    const ctx = await start();
    const auto = record();
    ctx.repository.records.set(auto.code, auto);
    const manual = record({ auto: false, autoKey: null });
    ctx.repository.records.set(manual.code, manual);
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const url = (code: string) => `${URL_BASE}/${code}/display`;
    const patch = (code: string, payload: unknown, h = owner) => app!.inject({ method: "PATCH", url: url(code), headers: h, payload: payload as Record<string, unknown> });

    const renamed = await patch(auto.code, { title: "Посев в Канале N", hidden: true });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ data: { title: string; hiddenAt: string | null; campaign: string } }>().data).toMatchObject({ title: "Посев в Канале N", campaign: "oct" });
    expect(renamed.json<{ data: { hiddenAt: string | null } }>().data.hiddenAt).not.toBeNull();

    expect((await patch(auto.code, {})).statusCode).toBe(400);
    expect((await patch(auto.code, { title: "я".repeat(81) })).statusCode).toBe(400);
    expect((await patch(auto.code, { title: "Имя\u0007с звонком" })).statusCode).toBe(400);
    expect((await patch(manual.code, { title: "Имя" })).statusCode).toBe(400);
    expect((await patch("NoSuchCode9", { hidden: true })).statusCode).toBe(404);

    // Без заголовка панели — отказ, как у любого изменения.
    expect((await patch(auto.code, { hidden: false }, { cookie: owner.cookie } as typeof owner)).statusCode).toBe(403);

    // Роль без `links.manage`: сессия есть, права нет.
    const outsider = await ctx.accounts.upsert({ platform: "telegram", platformUserId: "dev-player-930", displayName: "Модератор", username: null, photoUrl: null }, Date.now());
    await ctx.roles.grant(outsider.accountId, "moderator", null);
    const moderator = headers(await ctx.login("dev-player-930:Модератор"));
    expect((await patch(auto.code, { hidden: false }, moderator)).statusCode).toBe(403);
    expect(ctx.repository.records.get(auto.code)?.hiddenAt).not.toBeNull();
  });

  it("GET unknown-keys: не перехвачен маршрутом :code; ключи и потолок; без права — 403", async () => {
    const ctx = await start();
    ctx.keys.rows = [{ key: "utm", hits: 14, firstAt: new Date("2026-10-01T10:00:00Z"), lastAt: new Date("2026-10-27T21:40:00Z") }];
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const response = await app!.inject({ method: "GET", url: `${URL_BASE}/unknown-keys`, headers: owner });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { keys: { key: string; hits: number }[]; limit: number } }>().data).toMatchObject({ keys: [{ key: "utm", hits: 14 }], limit: 200 });

    const outsider = await ctx.accounts.upsert({ platform: "telegram", platformUserId: "dev-player-931", displayName: "Модератор", username: null, photoUrl: null }, Date.now());
    await ctx.roles.grant(outsider.accountId, "moderator", null);
    const moderator = headers(await ctx.login("dev-player-931:Модератор"));
    expect((await app!.inject({ method: "GET", url: `${URL_BASE}/unknown-keys`, headers: moderator })).statusCode).toBe(403);
  });

  it("слишком частые изменения — 429 с текстом сервера", async () => {
    const ctx = await start();
    const auto = record();
    ctx.repository.records.set(auto.code, auto);
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    ctx.limit.open = false;
    const response = await app!.inject({ method: "PATCH", url: `${URL_BASE}/${auto.code}/display`, headers: owner, payload: { hidden: true } });
    expect(response.statusCode).toBe(429);
    expect(response.json<{ error: { message: string } }>().error.message).toContain("подождите");
    expect(ctx.repository.records.get(auto.code)?.hiddenAt).toBeNull();
  });
});
