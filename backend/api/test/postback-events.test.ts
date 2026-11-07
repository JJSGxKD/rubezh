import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ConversionsJournal } from "../src/modules/ad-conversions/conversions-journal.service.js";
import { AdsgramDestination } from "../src/modules/ad-conversions/destinations/adsgram.destination.js";
import { DEFAULT_EVENTS, EVENT_TITLES, POSTBACK_EVENTS, eventsProblems, normalizeEvents } from "../src/modules/ad-conversions/postback-events.js";
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
 * Выбор событий постбэка (tasks/T-0071, docs/35-stage4-plan.md Р86, Р96): правила списка событий — чистыми
 * функциями, выбор у ссылки (`PATCH /admin/links/:code`, право `links.manage`) и у партнёра
 * (`POST /admin/partners/:partnerId`, право `partners.edit`) по HTTP панели. Запросы возвратов и покупок —
 * в postback-events.integration.test.ts.
 */

const OWNER_ID = "777000444";
const LINKS_URL = "/api/v1/admin/links";
const PARTNERS_URL = "/api/v1/admin/partners";
const ADDRESS = "https://track.example.com/pb?token=SECRET_VALUE&cid={click_id}&e={event}";
const NO_ADDRESS = "Сначала задайте адрес постбэка";

const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

/** Ссылки в памяти; запись адреса и событий — как в базе: названное пишется, не названное остаётся. */
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
  async setPostback(code: string, postback: { url?: string | null; since?: Date | null; events?: readonly string[] }): Promise<LinkRecord | null> {
    const link = this.records.get(code);
    if (link === undefined) return null;
    const next = {
      ...link,
      ...(postback.url === undefined ? {} : { postbackUrl: postback.url }),
      ...(postback.since === undefined ? {} : { postbackSince: postback.since }),
      ...(postback.events === undefined ? {} : { postbackEvents: [...postback.events] }),
    };
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

describe("список событий постбэка: правила", () => {
  it("события: четыре, в каноническом порядке; по умолчанию одна регистрация; подписи словами", () => {
    expect(POSTBACK_EVENTS).toEqual(["registration", "purchase_first", "purchase_repeat", "d1_return"]);
    expect(DEFAULT_EVENTS).toEqual(["registration"]);
    expect(EVENT_TITLES).toEqual({
      registration: "Регистрация",
      purchase_first: "Первая покупка",
      purchase_repeat: "Повторная покупка",
      d1_return: "Возврат на следующий день",
    });
  });

  it("eventsProblems: не список, пустой список, незнакомое событие — словами; верный список годится, повторы не ошибка", () => {
    expect(eventsProblems("registration")).toEqual(["События должны быть списком"]);
    expect(eventsProblems(null)).toEqual(["События должны быть списком"]);
    expect(eventsProblems({ 0: "registration" })).toEqual(["События должны быть списком"]);
    expect(eventsProblems([])).toEqual(["Выберите хотя бы одно событие"]);
    expect(eventsProblems(["registration", "x"])).toEqual(["Неизвестное событие: x"]);
    expect(eventsProblems(["x", "y"])).toEqual(["Неизвестное событие: x", "Неизвестное событие: y"]);
    expect(eventsProblems([5])).toEqual(["Неизвестное событие: 5"]);
    expect(eventsProblems(["d1_return", "registration", "registration"])).toEqual([]);
    expect(eventsProblems([...POSTBACK_EVENTS])).toEqual([]);
  });

  it("normalizeEvents: канонический порядок и без повторов", () => {
    expect(normalizeEvents(["d1_return", "registration", "registration"])).toEqual(["registration", "d1_return"]);
    expect(normalizeEvents(["purchase_repeat", "purchase_first"])).toEqual(["purchase_first", "purchase_repeat"]);
    expect(normalizeEvents([])).toEqual([]);
  });

  it("AdsGram возврат не принимает: три события, d1_return среди них нет", () => {
    const adsgram = new AdsgramDestination({ get: () => "token" });
    expect(adsgram.accepts).toEqual(["registration", "purchase_first", "purchase_repeat"]);
    expect(adsgram.accepts).not.toContain("d1_return");
  });
});

describe("выбор событий по HTTP панели", () => {
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
    const owner = headers(await login(`dev-${OWNER_ID}:Владелец`));
    return { roles, linksRepository, partnersRepository, owner, withRole };
  }

  const patchLink = (code: string, payload: unknown, h: Record<string, string>) =>
    app!.inject({ method: "PATCH", url: `${LINKS_URL}/${code}`, headers: h, payload: payload as Record<string, unknown> });
  const messageOf = (response: { json: <T>() => T }) => response.json<{ error: { message: string } }>().error.message;

  type LinkReply = { data: { postbackUrl: string | null; postbackEvents: string[]; target: string } };

  // --- Ссылка ---

  it("ссылка: события без адреса — 400 «Сначала задайте адрес постбэка», ничего не записано", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);

    const response = await patchLink(link.code, { postbackEvents: ["registration", "d1_return"] }, ctx.owner);
    expect(response.statusCode).toBe(400);
    expect(messageOf(response)).toBe(NO_ADDRESS);
    expect(ctx.linksRepository.records.get(link.code)).toMatchObject({ postbackUrl: null, postbackEvents: ["registration"] });
    expect(ctx.roles.entries.filter((entry) => entry.action === "links.postback.events")).toEqual([]);
  });

  it("ссылка: с адресом в том же запросе события сохраняются нормализованными", async () => {
    const ctx = await start();
    const link = record();
    ctx.linksRepository.records.set(link.code, link);

    const response = await patchLink(link.code, { postbackUrl: ADDRESS, postbackEvents: ["d1_return", "registration", "registration"] }, ctx.owner);
    expect(response.statusCode).toBe(200);
    expect(response.json<LinkReply>().data).toMatchObject({ postbackUrl: ADDRESS, postbackEvents: ["registration", "d1_return"] });
    expect(ctx.linksRepository.records.get(link.code)?.postbackEvents).toEqual(["registration", "d1_return"]);
  });

  it("ссылка: события при уже заданном адресе; аудит links.postback.events несёт before и after; тот же выбор — не запись", async () => {
    const ctx = await start();
    const link = record({ postbackUrl: ADDRESS, postbackSince: new Date("2026-11-02T10:00:00Z") });
    ctx.linksRepository.records.set(link.code, link);

    const first = await patchLink(link.code, { postbackEvents: ["purchase_repeat", "registration", "purchase_first"] }, ctx.owner);
    expect(first.statusCode).toBe(200);
    expect(first.json<LinkReply>().data.postbackEvents).toEqual(["registration", "purchase_first", "purchase_repeat"]);
    await patchLink(link.code, { postbackEvents: ["registration", "purchase_first", "purchase_repeat"] }, ctx.owner);

    const entries = ctx.roles.entries.filter((entry) => entry.action === "links.postback.events");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      target: link.code,
      before: { events: ["registration"] },
      after: { events: ["registration", "purchase_first", "purchase_repeat"] },
    });
    expect(JSON.stringify(ctx.roles.entries)).not.toContain("SECRET_VALUE");
  });

  it("ссылка: нет списка, пустой список, незнакомое событие — 400 словами проверки", async () => {
    const ctx = await start();
    const link = record({ postbackUrl: ADDRESS, postbackSince: new Date("2026-11-02T10:00:00Z") });
    ctx.linksRepository.records.set(link.code, link);

    const cases: [unknown, string][] = [
      ["registration", "События должны быть списком"],
      [null, "События должны быть списком"],
      [[], "Выберите хотя бы одно событие"],
      [["registration", "x"], "Неизвестное событие: x"],
    ];
    for (const [events, message] of cases) {
      const response = await patchLink(link.code, { postbackEvents: events }, ctx.owner);
      expect(response.statusCode, JSON.stringify(events)).toBe(400);
      expect(messageOf(response), JSON.stringify(events)).toBe(message);
    }
    expect(ctx.linksRepository.records.get(link.code)?.postbackEvents).toEqual(["registration"]);
  });

  it("ссылка: без links.manage — 403, чужой код — 404; события вместе со снятием адреса — 400 и адрес остаётся", async () => {
    const ctx = await start();
    const link = record({ postbackUrl: ADDRESS, postbackSince: new Date("2026-11-02T10:00:00Z") });
    ctx.linksRepository.records.set(link.code, link);
    const moderator = await ctx.withRole("dev-player-950", "moderator");

    expect((await patchLink(link.code, { postbackEvents: ["registration"] }, moderator)).statusCode).toBe(403);
    expect((await patchLink(link.code, { postbackEvents: ["registration"] }, { cookie: ctx.owner.cookie })).statusCode).toBe(403);
    expect((await patchLink("NoSuchCode9", { postbackEvents: ["registration"] }, ctx.owner)).statusCode).toBe(404);

    const removing = await patchLink(link.code, { postbackUrl: null, postbackEvents: ["registration", "d1_return"] }, ctx.owner);
    expect(removing.statusCode).toBe(400);
    expect(messageOf(removing)).toBe(NO_ADDRESS);
    expect(ctx.linksRepository.records.get(link.code)).toMatchObject({ postbackUrl: ADDRESS, postbackEvents: ["registration"] });
  });

  it("ссылка: снятие адреса возвращает события к «регистрация»", async () => {
    const ctx = await start();
    const link = record({ postbackUrl: ADDRESS, postbackSince: new Date("2026-11-02T10:00:00Z"), postbackEvents: ["registration", "d1_return"] });
    ctx.linksRepository.records.set(link.code, link);

    const removed = await patchLink(link.code, { postbackUrl: null }, ctx.owner);
    expect(removed.statusCode).toBe(200);
    expect(removed.json<LinkReply>().data).toMatchObject({ postbackUrl: null, postbackEvents: ["registration"] });
    expect(ctx.linksRepository.records.get(link.code)).toMatchObject({ postbackUrl: null, postbackSince: null, postbackEvents: ["registration"] });
  });

  it("ссылка: цель меняется вместе с событиями; запрос без цели, адреса и событий по-прежнему 400", async () => {
    const ctx = await start();
    const link = record({ postbackUrl: ADDRESS, postbackSince: new Date("2026-11-02T10:00:00Z") });
    ctx.linksRepository.records.set(link.code, link);

    const both = await patchLink(link.code, { target: "bot", postbackEvents: ["registration", "purchase_first"] }, ctx.owner);
    expect(both.statusCode).toBe(200);
    expect(both.json<LinkReply>().data).toMatchObject({ target: "bot", postbackEvents: ["registration", "purchase_first"] });
    expect((await patchLink(link.code, {}, ctx.owner)).statusCode).toBe(400);

    // События без адреса не оставляют после себя смены цели.
    const bare = record();
    ctx.linksRepository.records.set(bare.code, bare);
    expect((await patchLink(bare.code, { target: "landing", postbackEvents: ["registration"] }, ctx.owner)).statusCode).toBe(400);
    expect(ctx.linksRepository.records.get(bare.code)?.target).toBe("app");
  });

  // --- Партнёр ---

  type PartnerReply = { data: { partnerId: string; postbackUrl: string | null; postbackSince: string | null; postbackEvents: string[] } };
  const BODY = { name: "Канал", contact: "@channel", note: null };

  async function newPartner(owner: Record<string, string>): Promise<string> {
    const created = await app!.inject({ method: "POST", url: PARTNERS_URL, headers: owner, payload: BODY });
    expect(created.statusCode).toBe(201);
    return created.json<PartnerReply>().data.partnerId;
  }

  const postPartner = (partnerId: string, payload: unknown, h: Record<string, string>) =>
    app!.inject({ method: "POST", url: `${PARTNERS_URL}/${partnerId}`, headers: h, payload: payload as Record<string, unknown> });

  it("партнёр: события без адреса — 400; с адресом в том же запросе — сохранены нормализованными", async () => {
    const ctx = await start();
    const partnerId = await newPartner(ctx.owner);

    const bare = await postPartner(partnerId, { ...BODY, postbackEvents: ["registration", "d1_return"] }, ctx.owner);
    expect(bare.statusCode).toBe(400);
    expect(messageOf(bare)).toBe(NO_ADDRESS);
    expect(ctx.partnersRepository.rows.get(partnerId)?.postbackEvents ?? ["registration"]).toEqual(["registration"]);

    const saved = await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS, postbackEvents: ["d1_return", "registration"] }, ctx.owner);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<PartnerReply>().data).toMatchObject({ postbackUrl: ADDRESS, postbackEvents: ["registration", "d1_return"] });
  });

  it("партнёр: события при уже заданном адресе; правка без поля событий их не трогает; аудит «было → стало»", async () => {
    const ctx = await start();
    const partnerId = await newPartner(ctx.owner);
    await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS }, ctx.owner);

    const changed = await postPartner(partnerId, { ...BODY, postbackEvents: ["registration", "purchase_first", "purchase_repeat"] }, ctx.owner);
    expect(changed.json<PartnerReply>().data.postbackEvents).toEqual(["registration", "purchase_first", "purchase_repeat"]);
    const renamed = await postPartner(partnerId, { ...BODY, name: "Канал 2" }, ctx.owner);
    expect(renamed.json<PartnerReply>().data.postbackEvents).toEqual(["registration", "purchase_first", "purchase_repeat"]);

    const entries = ctx.roles.entries.filter((entry) => entry.action === "partner.update" && entry.target === partnerId);
    const withEvents = entries.filter((entry) => JSON.stringify(entry.after).includes("postbackEvents"));
    expect(withEvents).toHaveLength(1);
    expect(withEvents[0]).toMatchObject({
      before: { postbackEvents: ["registration"] },
      after: { postbackEvents: ["registration", "purchase_first", "purchase_repeat"] },
    });
    // Тот же выбор ещё раз — не запись в аудит.
    const count = entries.length;
    await postPartner(partnerId, { ...BODY, postbackEvents: ["purchase_repeat", "purchase_first", "registration"] }, ctx.owner);
    expect(ctx.roles.entries.filter((entry) => entry.action === "partner.update" && entry.target === partnerId)).toHaveLength(count);
  });

  it("партнёр: пустой список, незнакомое событие — 400; без partners.edit — 403; снятие адреса возвращает «регистрация»", async () => {
    const ctx = await start();
    const partnerId = await newPartner(ctx.owner);
    await postPartner(partnerId, { ...BODY, postbackUrl: ADDRESS, postbackEvents: ["registration", "d1_return"] }, ctx.owner);

    const empty = await postPartner(partnerId, { ...BODY, postbackEvents: [] }, ctx.owner);
    expect(empty.statusCode).toBe(400);
    expect(messageOf(empty)).toBe("Выберите хотя бы одно событие");
    const unknown = await postPartner(partnerId, { ...BODY, postbackEvents: ["teleport"] }, ctx.owner);
    expect(messageOf(unknown)).toBe("Неизвестное событие: teleport");

    const finance = await ctx.withRole("dev-player-951", "finance");
    expect((await postPartner(partnerId, { ...BODY, postbackEvents: ["registration"] }, finance)).statusCode).toBe(403);
    expect(ctx.partnersRepository.rows.get(partnerId)?.postbackEvents).toEqual(["registration", "d1_return"]);

    const removing = await postPartner(partnerId, { ...BODY, postbackUrl: null, postbackEvents: ["registration"] }, ctx.owner);
    expect(removing.statusCode).toBe(400);
    expect(messageOf(removing)).toBe(NO_ADDRESS);

    const removed = await postPartner(partnerId, { ...BODY, postbackUrl: null }, ctx.owner);
    expect(removed.json<PartnerReply>().data).toMatchObject({ postbackUrl: null, postbackSince: null, postbackEvents: ["registration"] });
  });
});
