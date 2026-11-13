import "reflect-metadata";
import { randomUUID } from "node:crypto";
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
import type { AutoSourcesRepository, UnknownKeyRow } from "../src/modules/links/auto-sources.repository.js";
import { newLinkCode } from "../src/modules/links/link-code.js";
import type { LinkDisplayPatch, LinkRecord, LinksRepository } from "../src/modules/links/links.repository.js";
import { LinksService } from "../src/modules/links/links.service.js";
import { PartnersService } from "../src/modules/partners/partners.service.js";
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
import { MemoryPartnersRepository } from "./helpers/memory-partners.js";
import { MemoryPromoCodesRepository } from "./helpers/memory-promo-codes.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Адрес постбэка в панели по HTTP (tasks/T-0070): у ссылки — `PATCH /admin/links/:code` под
 * `links.manage`, у партнёра — `POST /admin/partners/:partnerId` под `partners.edit`. Настоящие
 * охранники панели и права, ссылки и партнёры в памяти. Правила самого адреса — postback-template.test.ts.
 */

const OWNER_ID = "777000333";
const LINKS_URL = "/api/v1/admin/links";
const PARTNERS_URL = "/api/v1/admin/partners";
const ADDRESS = "https://track.example.com/pb?token=SECRET_VALUE&cid={click_id}&e={event}";
const REDACTED = "https://track.example.com/pb?***";
const OTHER_ADDRESS = "https://other.example.org/in?key=OTHER_SECRET&id={event_id}";

const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

class Links implements LinksRepository {
  readonly records = new Map<string, LinkRecord>();
  async create(): Promise<LinkRecord> {
    throw new Error("не нужно");
  }
  async byCode(code: string): Promise<LinkRecord | null> {
    return this.records.get(code) ?? null;
  }
  async setDisplay(code: string, patch: LinkDisplayPatch): Promise<LinkRecord | null> {
    void patch;
    return this.records.get(code) ?? null;
  }
  async recordClick(): Promise<void> {}
  async list(): Promise<never[]> {
    return [];
  }
  async partnerName(): Promise<string | null> {
    return null;
  }
  async retarget(code: string, target: LinkRecord["target"]): Promise<LinkRecord | null> {
    const link = this.records.get(code);
    if (link === undefined) return null;
    const next = { ...link, target };
    this.records.set(code, next);
    return next;
  }
  async setPostback(code: string, postback: { url: string | null; since: Date | null }): Promise<LinkRecord | null> {
    const link = this.records.get(code);
    if (link === undefined) return null;
    const next = { ...link, postbackUrl: postback.url, postbackSince: postback.since };
    this.records.set(code, next);
    return next;
  }
}

class Keys implements AutoSourcesRepository {
  async ensure(): Promise<"existing"> {
    return "existing";
  }
  async noteUnknownKeys(): Promise<void> {}
  async unknownKeys(): Promise<UnknownKeyRow[]> {
    return [];
  }
}

function record(patch: Partial<LinkRecord> = {}): LinkRecord {
  return {
    code: newLinkCode(),
    platform: "telegram",
    campaign: "channel-post",
    source: "tg",
    medium: null,
    note: null,
    createdBy: null,
    network: null,
    registrationOn: "first_run",
    target: "app",
    partner: null,
    createdAt: new Date("2026-11-01T10:00:00Z"),
    auto: false,
    autoKey: null,
    partnerTag: null,
    title: null,
    hiddenAt: null,
    postbackUrl: null,
    postbackSince: null,
    postbackEvents: ["registration"],
    ...patch,
  };
}

describe("адрес постбэка по HTTP панели", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const roleService = new RolesService(cfg, roles, accounts);
    const linksRepository = new Links();
    const appLinks = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    const links = new LinksService(cfg, linksRepository, appLinks, roleService, new Keys());
    const partnersRepository = new MemoryPartnersRepository(new MemoryPromoCodesRepository());
    const partners = new PartnersService(partnersRepository, roleService);
    const limiter = { consume: async () => true } as unknown as RateLimiter;
    @Module({
      controllers: [AdminSessionController, AdminLinksController, AdminPartnersController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: appLinks },
        { provide: LinksService, useValue: links },
        { provide: PartnersService, useValue: partners },
        { provide: ConversionsJournal, useValue: { summaries: async () => new Map() } },
        { provide: SecretsService, useValue: { get: () => null } },
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
    const headers = (cookie: string) => ({ cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
    /** Сессия человека с одной ролью: у `moderator` нет `links.manage`, у `finance` есть `partners.view`, но нет `partners.edit`. */
    const withRole = async (platformUserId: string, role: "moderator" | "finance") => {
      const account = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Помощник", username: null, photoUrl: null }, Date.now());
      await roles.grant(account.accountId, role, null);
      return headers(await login(`${platformUserId}:Помощник`));
    };
    return { roles, linksRepository, partnersRepository, headers, login, withRole };
  }

  const patchLink = (code: string, payload: unknown, h: Record<string, string>) =>
    app!.inject({ method: "PATCH", url: `${LINKS_URL}/${code}`, headers: h, payload: payload as Record<string, unknown> });

  type LinkReply = { data: { postbackUrl: string | null; postbackSince: string | null; postbackEvents: string[]; target: string } };

  it("ссылка: адрес не по правилам — 400 с текстом проверки; ничего не записано", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));

    const cases: [string, string][] = [
      ["http://track.example.com/pb", "Адрес должен начинаться с https://"],
      ["https://u:p@track.example.com/pb", "В адресе нельзя указывать логин и пароль"],
      ["https://track.example.com:8443/pb", "Порт в адресе не поддерживается"],
      ["https://{sub1}.example.com/pb", "Макросы нельзя ставить в имя сайта"],
      ["https://track.example.com/pb?x={nope}", "Макрос {nope} неизвестен. Доступны: {click_id}, {sub1}…{sub5}, {event}, {event_id}, {amount}, {currency}"],
      ["https://localhost/pb", "Адрес указывает на внутреннюю сеть"],
      [`https://track.example.com/${"a".repeat(1100)}`, "Адрес длиннее 1024 знаков"],
    ];
    for (const [address, message] of cases) {
      const response = await patchLink(link.code, { postbackUrl: address }, owner);
      expect(response.statusCode, address).toBe(400);
      expect(response.json<{ error: { message: string } }>().error.message, address).toBe(message);
    }
    expect(ctx.linksRepository.records.get(link.code)).toMatchObject({ postbackUrl: null, postbackSince: null });
    expect(ctx.roles.entries.filter((entry) => entry.action === "links.postback.set")).toEqual([]);
  });

  it("ссылка: без links.manage — 403, без заголовка панели — 403, чужой код — 404", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const moderator = await ctx.withRole("dev-player-940", "moderator");

    expect((await patchLink(link.code, { postbackUrl: ADDRESS }, moderator)).statusCode).toBe(403);
    expect((await patchLink(link.code, { postbackUrl: ADDRESS }, { cookie: owner.cookie } as typeof owner)).statusCode).toBe(403);
    expect((await patchLink("NoSuchCode9", { postbackUrl: ADDRESS }, owner)).statusCode).toBe(404);
    expect(ctx.linksRepository.records.get(link.code)?.postbackUrl).toBeNull();
  });

  it("ссылка: первое задание адреса ставит postback_since, смена адреса его не меняет, снятие и пустая строка обнуляют", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));

    const before = Date.now();
    const first = await patchLink(link.code, { postbackUrl: ADDRESS }, owner);
    expect(first.statusCode).toBe(200);
    const set = first.json<LinkReply>().data;
    expect(set).toMatchObject({ postbackUrl: ADDRESS, postbackEvents: ["registration"] });
    const since = new Date(set.postbackSince ?? "").getTime();
    expect(since).toBeGreaterThanOrEqual(before - 1_000);
    expect(since).toBeLessThanOrEqual(Date.now() + 1_000);

    // Другой адрес — тот же момент: клики после первого задания остаются в силе.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const changed = (await patchLink(link.code, { postbackUrl: OTHER_ADDRESS }, owner)).json<LinkReply>().data;
    expect(changed).toMatchObject({ postbackUrl: OTHER_ADDRESS, postbackSince: set.postbackSince });

    // Тот же адрес ещё раз — запись и аудит не нужны.
    await patchLink(link.code, { postbackUrl: OTHER_ADDRESS }, owner);
    expect(ctx.roles.entries.filter((entry) => entry.action === "links.postback.set")).toHaveLength(2);

    // Пустая строка снимает адрес и обнуляет оба поля.
    const cleared = (await patchLink(link.code, { postbackUrl: "" }, owner)).json<LinkReply>().data;
    expect(cleared).toMatchObject({ postbackUrl: null, postbackSince: null });

    // Новое задание после снятия — новый момент.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const again = (await patchLink(link.code, { postbackUrl: ADDRESS }, owner)).json<LinkReply>().data;
    expect(new Date(again.postbackSince ?? "").getTime()).toBeGreaterThan(since);

    const removed = (await patchLink(link.code, { postbackUrl: null }, owner)).json<LinkReply>().data;
    expect(removed).toMatchObject({ postbackUrl: null, postbackSince: null });
    expect(ctx.linksRepository.records.get(link.code)).toMatchObject({ postbackUrl: null, postbackSince: null });
  });

  it("ссылка: пробелы по краям обрезаются; снимать адрес, которого нет, — не запись", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));

    expect((await patchLink(link.code, { postbackUrl: `  ${ADDRESS}  ` }, owner)).json<LinkReply>().data.postbackUrl).toBe(ADDRESS);
    const empty = record();
    ctx.linksRepository.records.set(empty.code, empty);
    expect((await patchLink(empty.code, { postbackUrl: null }, owner)).statusCode).toBe(200);
    expect(ctx.roles.entries.filter((entry) => entry.action === "links.postback.set" && entry.target === empty.code)).toEqual([]);
  });

  it("ссылка: аудит links.postback.set несёт адрес без запроса — «https://host/path?***»", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));

    await patchLink(link.code, { postbackUrl: ADDRESS }, owner);
    await patchLink(link.code, { postbackUrl: null }, owner);
    const entries = ctx.roles.entries.filter((entry) => entry.action === "links.postback.set");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ target: link.code, after: { postback: REDACTED } });
    expect(entries[1]).toMatchObject({ target: link.code, before: { postback: REDACTED }, after: { postback: null } });
    expect(JSON.stringify(entries)).not.toContain("SECRET_VALUE");
    expect(JSON.stringify(entries)).not.toContain("click_id");
  });

  it("ссылка: лишнее поле тела и пустое тело — 400; цель по-прежнему меняется, вместе с адресом — тоже", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));

    expect((await patchLink(link.code, { postbackUrl: ADDRESS, partnerId: randomUUID() }, owner)).statusCode).toBe(400);
    expect((await patchLink(link.code, { postbackUrl: ADDRESS, network: "adsgram" }, owner)).statusCode).toBe(400);
    expect((await patchLink(link.code, {}, owner)).statusCode).toBe(400);
    expect((await patchLink(link.code, { postbackUrl: 5 }, owner)).statusCode).toBe(400);
    expect(ctx.linksRepository.records.get(link.code)?.postbackUrl).toBeNull();

    const retargeted = await patchLink(link.code, { target: "bot" }, owner);
    expect(retargeted.statusCode).toBe(200);
    expect(retargeted.json<LinkReply>().data).toMatchObject({ target: "bot", postbackUrl: null });
    const both = await patchLink(link.code, { target: "landing", postbackUrl: ADDRESS }, owner);
    expect(both.json<LinkReply>().data).toMatchObject({ target: "landing", postbackUrl: ADDRESS });
  });

  // --- Партнёр ---

  type PartnerReply = { data: { partnerId: string; name: string; postbackUrl: string | null; postbackSince: string | null; postbackEvents: string[] } };
  const BODY = { name: "Канал", contact: "@channel", note: null };

  async function newPartner(ctx: Awaited<ReturnType<typeof start>>, owner: Record<string, string>): Promise<string> {
    const created = await app!.inject({ method: "POST", url: PARTNERS_URL, headers: owner, payload: BODY });
    expect(created.statusCode).toBe(201);
    return created.json<PartnerReply>().data.partnerId;
  }

  const postPartner = (partnerId: string, payload: unknown, h: Record<string, string>) =>
    app!.inject({ method: "POST", url: `${PARTNERS_URL}/${partnerId}`, headers: h, payload: payload as Record<string, unknown> });

  it("партнёр: адрес не по правилам — 400 с текстом проверки; без partners.edit — 403", async () => {
    const ctx = await start();
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const partnerId = await newPartner(ctx, owner);

    for (const [address, message] of [
      ["http://track.example.com/pb", "Адрес должен начинаться с https://"],
      ["https://10.0.0.5/pb", "Адрес указывает на внутреннюю сеть"],
      ["https://track.example.com/pb?x={nope}", "Макрос {nope} неизвестен. Доступны: {click_id}, {sub1}…{sub5}, {event}, {event_id}, {amount}, {currency}"],
    ] as const) {
      const response = await postPartner(partnerId, { ...BODY, postbackUrl: address }, owner);
      expect(response.statusCode, address).toBe(400);
      expect(response.json<{ error: { message: string } }>().error.message, address).toBe(message);
    }

    // Бухгалтерия партнёров видит, но не правит.
    const finance = await ctx.withRole("dev-player-941", "finance");
    expect((await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, finance)).statusCode).toBe(403);
    expect((await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, { cookie: owner.cookie } as typeof owner)).statusCode).toBe(403);
    expect(ctx.partnersRepository.rows.get(partnerId)?.postbackUrl ?? null).toBeNull();
  });

  it("партнёр: postback_since — как у ссылки; правка без поля адреса его не трогает; лишнее поле — 400", async () => {
    const ctx = await start();
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const partnerId = await newPartner(ctx, owner);

    const first = (await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, owner)).json<PartnerReply>().data;
    expect(first).toMatchObject({ postbackUrl: ADDRESS, postbackEvents: ["registration"] });
    expect(first.postbackSince).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 15));
    const changed = (await postPartner(partnerId, { ...BODY, postbackUrl: OTHER_ADDRESS }, owner)).json<PartnerReply>().data;
    expect(changed).toMatchObject({ postbackUrl: OTHER_ADDRESS, postbackSince: first.postbackSince });

    const renamed = (await postPartner(partnerId, { ...BODY, name: "Канал 2" }, owner)).json<PartnerReply>().data;
    expect(renamed).toMatchObject({ name: "Канал 2", postbackUrl: OTHER_ADDRESS, postbackSince: first.postbackSince });

    expect((await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS, postbackEvents: ["teleport"] }, owner)).statusCode).toBe(400);
    expect((await postPartner(partnerId, { ...BODY, postbackSince: "2020-01-01T00:00:00Z" }, owner)).statusCode).toBe(400);
    expect((await postPartner(partnerId, { ...BODY, postbackUrl: 5 }, owner)).statusCode).toBe(400);

    expect((await postPartner(partnerId, { ...BODY, postbackUrl: "" }, owner)).json<PartnerReply>().data).toMatchObject({ postbackUrl: null, postbackSince: null });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const again = (await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, owner)).json<PartnerReply>().data;
    expect(new Date(again.postbackSince ?? "").getTime()).toBeGreaterThan(new Date(first.postbackSince ?? "").getTime());
    expect((await postPartner(partnerId, { ...BODY, postbackUrl: null }, owner)).json<PartnerReply>().data).toMatchObject({ postbackUrl: null, postbackSince: null });
  });

  it("партнёр: заводится без адреса, и поле адреса в теле заведения — 400", async () => {
    const ctx = await start();
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const created = await app!.inject({ method: "POST", url: PARTNERS_URL, headers: owner, payload: { ...BODY, postbackUrl: ADDRESS } });
    expect(created.statusCode).toBe(400);
    const partnerId = await newPartner(ctx, owner);
    expect((await app!.inject({ method: "GET", url: `${PARTNERS_URL}/${partnerId}`, headers: owner })).json<{ data: { partner: PartnerReply["data"] } }>().data.partner).toMatchObject({
      postbackUrl: null,
      postbackSince: null,
      postbackEvents: ["registration"],
    });
  });

  it("партнёр: аудит «было → стало» несёт адрес без запроса", async () => {
    const ctx = await start();
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const partnerId = await newPartner(ctx, owner);
    await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, owner);
    await postPartner(partnerId, { ...BODY, postbackUrl: OTHER_ADDRESS }, owner);
    await postPartner(partnerId, { ...BODY, postbackUrl: null }, owner);

    const entries = ctx.roles.entries.filter((entry) => entry.action === "partner.update" && entry.target === partnerId);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ before: { postbackUrl: null }, after: { postbackUrl: REDACTED } });
    expect(entries[1]).toMatchObject({ before: { postbackUrl: REDACTED }, after: { postbackUrl: "https://other.example.org/in?***" } });
    expect(entries[2]).toMatchObject({ before: { postbackUrl: "https://other.example.org/in?***" }, after: { postbackUrl: null } });
    const everything = JSON.stringify(ctx.roles.entries);
    expect(everything).not.toContain("SECRET_VALUE");
    expect(everything).not.toContain("OTHER_SECRET");
  });

  it("партнёр: полный адрес видит тот, у кого право на правку; остальные — без запроса", async () => {
    const ctx = await start();
    const owner = ctx.headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const partnerId = await newPartner(ctx, owner);
    await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, owner);
    const finance = await ctx.withRole("dev-player-942", "finance");

    const own = await app!.inject({ method: "GET", url: `${PARTNERS_URL}/${partnerId}`, headers: owner });
    expect(own.json<{ data: { partner: PartnerReply["data"] } }>().data.partner.postbackUrl).toBe(ADDRESS);
    const seen = await app!.inject({ method: "GET", url: `${PARTNERS_URL}/${partnerId}`, headers: finance });
    expect(seen.statusCode).toBe(200);
    expect(seen.json<{ data: { partner: PartnerReply["data"] } }>().data.partner.postbackUrl).toBe(REDACTED);
    const catalog = await app!.inject({ method: "GET", url: PARTNERS_URL, headers: finance });
    expect(JSON.stringify(catalog.json())).not.toContain("SECRET_VALUE");
    expect(catalog.json<{ data: { partners: PartnerReply["data"][] } }>().data.partners[0]?.postbackUrl).toBe(REDACTED);
    const ownCatalog = await app!.inject({ method: "GET", url: PARTNERS_URL, headers: owner });
    expect(ownCatalog.json<{ data: { partners: PartnerReply["data"][] } }>().data.partners[0]?.postbackUrl).toBe(ADDRESS);
  });
});
