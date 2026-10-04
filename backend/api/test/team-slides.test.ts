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
import { AdminHomeController } from "../src/modules/admin/admin-home.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import {
  TEAM_SLIDE_LIMITS,
  inAudience,
  teamSlideInputSchema,
  teamSlidePeriodProblem,
  teamSlidesFor,
  teamSlideState,
  type AudienceFacts,
  type TeamSlideInput,
  type TeamSlideRow,
} from "../src/modules/home/team-slide-rules.js";
import { TeamSlidesService } from "../src/modules/home/team-slides.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { MediaService } from "../src/modules/media/media.service.js";
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
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryTeamSlideRepository } from "./helpers/memory-team-slides.js";

/**
 * Слайды команды на главной (docs/35-stage4-plan.md WP42, часть 2): анонс
 * от команды — кому, где и на какой срок; заводят, правят и снимают в панели
 * под своим правом, с аудитом.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 4, 9));
const OWNER_ID = "777000222";
const IMAGE = "a".repeat(64);

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof DomainError ? error.code : "unknown";
  }
}

function input(patch: Partial<TeamSlideInput> = {}): TeamSlideInput {
  return {
    title: "Турнир выходного дня",
    text: "Лучшее время — в рейтинге",
    imageId: null,
    icon: "trophy",
    target: { kind: "screen", screen: "rating" },
    platforms: ["telegram"],
    audience: "all",
    pinned: false,
    startsAt: at(0),
    endsAt: at(3 * DAY),
    ...patch,
  };
}

function row(patch: Partial<TeamSlideRow> = {}): TeamSlideRow {
  return { slideId: randomUUID(), ...input(), createdAt: NOW, createdBy: "x", updatedAt: NOW, updatedBy: "x", archivedAt: null, archivedBy: null, ...patch };
}

const facts = (patch: Partial<AudienceFacts> = {}): AudienceFacts => ({ platform: "telegram", createdAt: at(-30 * DAY), payer: false, vip: false, ...patch });

describe("правила слайда команды", () => {
  it("строка без переводов и лишних пробелов; пустая и длинная — отказ", () => {
    const parsed = teamSlideInputSchema.parse({ ...input(), title: "  Турнир \n выходного   дня ", startsAt: NOW.toISOString(), endsAt: at(DAY).toISOString() });
    expect(parsed.title).toBe("Турнир выходного дня");
    expect(teamSlideInputSchema.safeParse({ ...input(), title: "   ", startsAt: NOW.toISOString(), endsAt: at(DAY).toISOString() }).success).toBe(false);
    expect(teamSlideInputSchema.safeParse({ ...input(), text: "я".repeat(TEAM_SLIDE_LIMITS.textMax + 1), startsAt: NOW.toISOString(), endsAt: at(DAY).toISOString() }).success).toBe(false);
  });

  it("ссылка — только https; экран — только из списка; площадка хоть одна, без повторов; лишнее поле — отказ", () => {
    const base = { ...input(), startsAt: NOW.toISOString(), endsAt: at(DAY).toISOString() };
    expect(teamSlideInputSchema.safeParse({ ...base, target: { kind: "link", url: "https://t.me/rubezh" } }).success).toBe(true);
    for (const url of ["http://t.me/rubezh", "tg://resolve?domain=x", "javascript:alert(1)"]) {
      expect(teamSlideInputSchema.safeParse({ ...base, target: { kind: "link", url } }).success, url).toBe(false);
    }
    expect(teamSlideInputSchema.safeParse({ ...base, target: { kind: "screen", screen: "run" } }).success).toBe(false);
    expect(teamSlideInputSchema.safeParse({ ...base, platforms: [] }).success).toBe(false);
    expect(teamSlideInputSchema.parse({ ...base, platforms: ["telegram", "telegram", "vk"] }).platforms).toEqual(["telegram", "vk"]);
    expect(teamSlideInputSchema.safeParse({ ...base, order: 1 }).success).toBe(false);
  });

  it("срок: не в прошлом, не дальше чем за 60 дней, не дольше 60 дней; у идущего начало в прошлом — можно", () => {
    expect(teamSlidePeriodProblem({ startsAt: at(0), endsAt: at(DAY) }, NOW, false)).toBeNull();
    expect(teamSlidePeriodProblem({ startsAt: at(DAY), endsAt: at(0) }, NOW, false)).toBe("Конец — позже начала");
    expect(teamSlidePeriodProblem({ startsAt: at(-DAY), endsAt: at(DAY) }, NOW, false)).toBe("Слайд не начинается в прошлом");
    expect(teamSlidePeriodProblem({ startsAt: at(-DAY), endsAt: at(DAY) }, NOW, true)).toBeNull();
    expect(teamSlidePeriodProblem({ startsAt: at(-3 * DAY), endsAt: at(-DAY) }, NOW, true)).toBe("Слайд кончается в прошлом");
    expect(teamSlidePeriodProblem({ startsAt: at(61 * DAY), endsAt: at(62 * DAY) }, NOW, false)).toContain("не дальше");
    expect(teamSlidePeriodProblem({ startsAt: at(0), endsAt: at(61 * DAY) }, NOW, false)).toContain("не дольше");
  });

  it("состояние для панели: будущий, идёт, кончился, снят", () => {
    expect(teamSlideState(row({ startsAt: at(HOUR) }), NOW)).toBe("scheduled");
    expect(teamSlideState(row(), NOW)).toBe("active");
    expect(teamSlideState(row({ startsAt: at(-2 * DAY), endsAt: at(-DAY) }), NOW)).toBe("ended");
    expect(teamSlideState(row({ archivedAt: NOW }), NOW)).toBe("archived");
  });
});

describe("аудитория слайда", () => {
  it("площадка — из списка слайда; все — каждому", () => {
    expect(inAudience(row({ platforms: ["telegram"] }), facts(), NOW)).toBe(true);
    expect(inAudience(row({ platforms: ["vk"] }), facts(), NOW)).toBe(false);
  });

  it("новички — первые 7 суток; платившие и нет — по первой настоящей оплате; VIP — пока идёт", () => {
    const newbies = row({ audience: "newbies" });
    expect(inAudience(newbies, facts({ createdAt: at(-6 * DAY) }), NOW)).toBe(true);
    expect(inAudience(newbies, facts({ createdAt: at(-7 * DAY) }), NOW)).toBe(false);
    expect(inAudience(row({ audience: "payers" }), facts({ payer: true }), NOW)).toBe(true);
    expect(inAudience(row({ audience: "payers" }), facts(), NOW)).toBe(false);
    expect(inAudience(row({ audience: "nonpayers" }), facts(), NOW)).toBe(true);
    expect(inAudience(row({ audience: "nonpayers" }), facts({ payer: true }), NOW)).toBe(false);
    expect(inAudience(row({ audience: "vip" }), facts({ vip: true }), NOW)).toBe(true);
    expect(inAudience(row({ audience: "vip" }), facts(), NOW)).toBe(false);
  });

  it("не узнали факт — слайд, которому он нужен, не показывается; «всем» — показывается", () => {
    const unknown = facts({ createdAt: null, payer: null, vip: null });
    for (const audience of ["newbies", "payers", "nonpayers", "vip"] as const) {
      expect(inAudience(row({ audience }), unknown, NOW), audience).toBe(false);
    }
    expect(inAudience(row(), unknown, NOW)).toBe(true);
  });

  it("игроку — идущие, закреплённые первыми, дальше начавшиеся позже; не больше двух", () => {
    const older = row({ title: "старый", startsAt: at(-2 * DAY) });
    const newer = row({ title: "новый", startsAt: at(-DAY) });
    const pinned = row({ title: "закреплённый", startsAt: at(-3 * DAY), pinned: true });
    const future = row({ title: "будущий", startsAt: at(HOUR) });
    const archived = row({ title: "снятый", archivedAt: NOW });
    expect(teamSlidesFor([older, newer, pinned, future, archived], facts(), NOW).map((slide) => slide.title)).toEqual(["закреплённый", "новый"]);
  });
});

function setup(config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv)) {
  const repository = new MemoryTeamSlideRepository();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const required: string[] = [];
  const media = { require: async (imageId: string, profile: string) => void required.push(`${profile}:${imageId}`) } as unknown as MediaService;
  const service = new TeamSlidesService(repository, new RolesService(config, roles, accounts), media);
  return { repository, accounts, roles, service, required };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role?: "admin" | "marketer" | "game_designer" | "moderator" | "finance"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

describe("слайды команды в панели", () => {
  it("право — у владельца, администратора, маркетолога и геймдизайнера", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes("home.edit"))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["admin", "game_designer", "marketer", "owner"]);
  });

  it("маркетолог заводит, правит и снимает с аудитом; модератору и бухгалтерии — 403", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "100", "marketer");
    const created = await ctx.service.create(marketer, input(), NOW);
    expect(created).toMatchObject({ title: "Турнир выходного дня", state: "active", createdBy: marketer.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: marketer.accountId, action: "home.slide.create", target: created.slideId });

    const updated = await ctx.service.update(marketer, created.slideId, input({ text: "Призы — самоцветы" }), at(HOUR));
    expect(updated.text).toBe("Призы — самоцветы");
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "home.slide.update", before: { text: "Лучшее время — в рейтинге" }, after: { text: "Призы — самоцветы", target: "screen:rating" } });

    const archived = await ctx.service.archive(marketer, created.slideId, at(2 * HOUR));
    expect(archived).toMatchObject({ state: "archived", archivedBy: marketer.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "home.slide.archive", target: created.slideId });
    // Снятый не правится и второй раз не снимается.
    expect(await codeOf(ctx.service.update(marketer, created.slideId, input(), at(3 * HOUR)))).toBe("team_slide_not_found");
    expect(await codeOf(ctx.service.archive(marketer, created.slideId, at(3 * HOUR)))).toBe("team_slide_not_found");

    for (const role of ["moderator", "finance"] as const) {
      const outsider = await person(ctx, `2${role}`, role);
      expect(await codeOf(ctx.service.create(outsider, input(), NOW)), role).toBe("forbidden");
      expect(await codeOf(ctx.service.catalog(outsider, NOW)), role).toBe("forbidden");
    }
  });

  it("срок вне пределов — 400 с объяснением; у идущего слайда правка с прежним началом проходит", async () => {
    const ctx = setup();
    const admin = await person(ctx, "300", "admin");
    expect(await codeOf(ctx.service.create(admin, input({ startsAt: at(-DAY) }), NOW))).toBe("team_slide_period");
    const created = await ctx.service.create(admin, input(), NOW);
    expect(await codeOf(ctx.service.update(admin, created.slideId, input({ title: "Турнир" }), at(DAY)))).toBe("ok");
    expect(await codeOf(ctx.service.update(admin, created.slideId, input({ endsAt: at(DAY) }), at(2 * DAY)))).toBe("team_slide_period");
  });

  it("картинка проверяется профилем слайда — новая, а прежняя при правке — нет", async () => {
    const ctx = setup();
    const admin = await person(ctx, "400", "admin");
    const created = await ctx.service.create(admin, input({ imageId: IMAGE }), NOW);
    await ctx.service.update(admin, created.slideId, input({ imageId: IMAGE, title: "Турнир" }), NOW);
    await ctx.service.update(admin, created.slideId, input({ imageId: "b".repeat(64) }), NOW);
    expect(ctx.required).toEqual([`home_slide:${IMAGE}`, `home_slide:${"b".repeat(64)}`]);
  });

  it("список для панели — с состоянием, поздние первыми, с пределами и списками для формы", async () => {
    const ctx = setup();
    const admin = await person(ctx, "500", "admin");
    await ctx.service.create(admin, input({ title: "прошлый", startsAt: at(0), endsAt: at(HOUR) }), NOW);
    await ctx.service.create(admin, input({ title: "будущий", startsAt: at(DAY), endsAt: at(2 * DAY) }), NOW);
    const view = await ctx.service.catalog(admin, at(2 * HOUR));
    expect(view.slides.map((slide) => [slide.title, slide.state])).toEqual([
      ["будущий", "scheduled"],
      ["прошлый", "ended"],
    ]);
    expect(view.limits).toEqual(TEAM_SLIDE_LIMITS);
    expect(view.screens).toContain("rating");
    expect(view.audiences).toEqual(["all", "newbies", "payers", "nonpayers", "vip"]);
  });

  it("идущие — из памяти полминуты; заведённый в панели виден сразу на этой реплике", async () => {
    const ctx = setup();
    const admin = await person(ctx, "600", "admin");
    expect(await ctx.service.forPlayer(facts(), NOW)).toEqual([]);
    expect(await ctx.service.forPlayer(facts(), at(1_000))).toEqual([]);
    expect(ctx.repository.currentCalls).toBe(1);
    await ctx.service.create(admin, input(), at(2_000));
    expect((await ctx.service.forPlayer(facts(), at(3_000))).map((slide) => slide.title)).toEqual(["Турнир выходного дня"]);
  });
});

describe("слайды команды по HTTP панели", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("владелец видит список, заводит, правит и снимает; мусор — 400, без заголовка панели — 403", async () => {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup(cfg);
    @Module({
      controllers: [AdminSessionController, AdminHomeController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: TeamSlidesService, useValue: ctx.service },
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
    const payload = { ...input(), startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3 * DAY).toISOString() };
    const url = "/api/v1/admin/home/slides";

    const list = await app.inject({ method: "GET", url, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: { slides: unknown[] } }>().data.slides).toEqual([]);

    expect((await app.inject({ method: "POST", url, headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers, payload: { ...payload, target: { kind: "link", url: "http://x.ru" } } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url, headers, payload });
    expect(created.statusCode).toBe(201);
    const slideId = created.json<{ data: { slideId: string } }>().data.slideId;

    const updated = await app.inject({ method: "PUT", url: `${url}/${slideId}`, headers, payload: { ...payload, title: "Турнир" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ data: { title: string } }>().data.title).toBe("Турнир");
    expect((await app.inject({ method: "PUT", url: `${url}/не-uuid`, headers, payload })).statusCode).toBe(400);

    const archived = await app.inject({ method: "POST", url: `${url}/${slideId}/archive`, headers });
    expect(archived.statusCode).toBe(201);
    expect(archived.json<{ data: { state: string } }>().data.state).toBe("archived");
    expect((await app.inject({ method: "POST", url: `${url}/${randomUUID()}/archive`, headers })).statusCode).toBe(404);
  });
});
