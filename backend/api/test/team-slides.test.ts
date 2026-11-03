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
  teamSlideGroup,
  teamSlideInputSchema,
  teamSlideOrderSchema,
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
  return { slideId: randomUUID(), ...input(), position: 0, createdAt: NOW, createdBy: "x", updatedAt: NOW, updatedBy: "x", archivedAt: null, archivedBy: null, ...patch };
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

  it("внутри группы — по месту в списке, а не по началу; равные места — позже начатый, затем по id", () => {
    const first = row({ title: "второй по началу", position: 1, startsAt: at(-DAY) });
    const second = row({ title: "первый по месту", position: 0, startsAt: at(-2 * DAY) });
    expect(teamSlidesFor([first, second], facts(), NOW).map((slide) => slide.title)).toEqual(["первый по месту", "второй по началу"]);

    const early = row({ title: "рано", startsAt: at(-2 * DAY) });
    const late = row({ title: "поздно", startsAt: at(-DAY) });
    expect(teamSlidesFor([early, late], facts(), NOW).map((slide) => slide.title)).toEqual(["поздно", "рано"]);

    const a = row({ slideId: "00000000-0000-4000-8000-000000000001", title: "a" });
    const b = row({ slideId: "00000000-0000-4000-8000-000000000002", title: "b" });
    expect(teamSlidesFor([b, a], facts(), NOW).map((slide) => slide.title)).toEqual(["a", "b"]);
  });

  it("закреплённые идут перед остальными, какое бы место ни было; из трёх идущих игрок получает два верхних", () => {
    const regular = row({ title: "обычный", position: 0 });
    const pinned = row({ title: "закреплённый", pinned: true, position: 5 });
    const third = row({ title: "третий", position: 1 });
    expect(teamSlidesFor([third, regular, pinned], facts(), NOW).map((slide) => slide.title)).toEqual(["закреплённый", "обычный"]);
    expect(teamSlideGroup(pinned)).toBe("pinned");
    expect(teamSlideGroup(regular)).toBe("regular");
  });
});

describe("запрос порядка слайдов", () => {
  const ids = [randomUUID(), randomUUID()];

  it("группа и id без повторов; принимается ровно то, что нужно", () => {
    expect(teamSlideOrderSchema.parse({ group: "regular", ids })).toEqual({ group: "regular", ids });
    expect(teamSlideOrderSchema.safeParse({ group: "pinned", ids: [ids[0]] }).success).toBe(true);
  });

  it("чужая группа, пустой список, повтор, не UUID, лишнее поле и больше 200 id — отказ", () => {
    expect(teamSlideOrderSchema.safeParse({ group: "other", ids }).success).toBe(false);
    expect(teamSlideOrderSchema.safeParse({ group: "regular", ids: [] }).success).toBe(false);
    expect(teamSlideOrderSchema.safeParse({ group: "regular", ids: [ids[0], ids[0]] }).success).toBe(false);
    expect(teamSlideOrderSchema.safeParse({ group: "regular", ids: ["не-uuid"] }).success).toBe(false);
    expect(teamSlideOrderSchema.safeParse({ group: "regular", ids, extra: 1 }).success).toBe(false);
    expect(teamSlideOrderSchema.safeParse({ group: "regular", ids: Array.from({ length: 201 }, () => randomUUID()) }).success).toBe(false);
    expect(teamSlideOrderSchema.safeParse({ group: "regular", ids: Array.from({ length: 200 }, () => randomUUID()) }).success).toBe(true);
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
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "home.slide.update", before: { text: "Лучшее время — в рейтинге" }, after: { text: "Призы — самоцветы", screen: "rating", link: null, platforms: ["telegram"], forWhom: "all" } });

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

  it("список для панели — с состоянием и местом, в порядке списка, с пределами и списками для формы", async () => {
    const ctx = setup();
    const admin = await person(ctx, "500", "admin");
    await ctx.service.create(admin, input({ title: "прошлый", startsAt: at(0), endsAt: at(HOUR) }), NOW);
    await ctx.service.create(admin, input({ title: "будущий", startsAt: at(DAY), endsAt: at(2 * DAY) }), NOW);
    const view = await ctx.service.catalog(admin, at(2 * HOUR));
    expect(view.slides.map((slide) => [slide.title, slide.state, slide.position])).toEqual([
      ["прошлый", "ended", 0],
      ["будущий", "scheduled", 1],
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

describe("порядок слайдов в панели", () => {
  async function three(ctx: ReturnType<typeof setup>, admin: AccountRef, patch: Partial<TeamSlideInput> = {}) {
    const a = await ctx.service.create(admin, input({ title: "A", ...patch }), NOW);
    const b = await ctx.service.create(admin, input({ title: "B", ...patch }), NOW);
    const c = await ctx.service.create(admin, input({ title: "C", ...patch }), NOW);
    return [a.slideId, b.slideId, c.slideId] as const;
  }
  const titles = async (ctx: ReturnType<typeof setup>, admin: AccountRef) => (await ctx.service.catalog(admin, NOW)).slides.map((slide) => [slide.title, slide.position]);

  it("новый слайд встаёт последним в своей группе; в пустой группе — с нуля; группы считаются отдельно", async () => {
    const ctx = setup();
    const admin = await person(ctx, "700", "admin");
    expect((await ctx.service.create(admin, input({ title: "Р1" }), NOW)).position).toBe(0);
    expect((await ctx.service.create(admin, input({ title: "Р2" }), NOW)).position).toBe(1);
    expect((await ctx.service.create(admin, input({ title: "З1", pinned: true }), NOW)).position).toBe(0);
    expect((await ctx.service.create(admin, input({ title: "Р3" }), NOW)).position).toBe(2);
  });

  it("снятые при подсчёте места не считаются", async () => {
    const ctx = setup();
    const admin = await person(ctx, "701", "admin");
    await ctx.service.create(admin, input({ title: "Р1" }), NOW);
    const second = await ctx.service.create(admin, input({ title: "Р2" }), NOW);
    await ctx.service.archive(admin, second.slideId, NOW);
    expect((await ctx.service.create(admin, input({ title: "Р3" }), NOW)).position).toBe(1);
  });

  it("поля места во входе нет: слой схемы отвергает лишнее", () => {
    expect(teamSlideInputSchema.safeParse({ ...input(), position: 3, startsAt: NOW.toISOString(), endsAt: at(DAY).toISOString() }).success).toBe(false);
  });

  it("правка текста место не трогает; смена закрепления переводит слайд в конец другой группы", async () => {
    const ctx = setup();
    const admin = await person(ctx, "702", "admin");
    const [a, b] = await three(ctx, admin);
    await ctx.service.create(admin, input({ title: "З", pinned: true }), NOW);
    await ctx.service.update(admin, a, input({ title: "A1", text: "Другой текст" }), NOW);
    expect(await titles(ctx, admin)).toEqual([["З", 0], ["A1", 0], ["B", 1], ["C", 2]]);

    const moved = await ctx.service.update(admin, b, input({ title: "B", pinned: true }), NOW);
    expect(moved.position).toBe(1);
    expect(await titles(ctx, admin)).toEqual([["З", 0], ["B", 1], ["A1", 0], ["C", 2]]);
  });

  it("перестановка отдаёт новый порядок и места 0, 1, 2; игрок видит его сразу — кэш идущих сброшен", async () => {
    const ctx = setup();
    const admin = await person(ctx, "703", "admin");
    const [a, b, c] = await three(ctx, admin);
    expect((await ctx.service.forPlayer(facts(), NOW)).map((slide) => slide.title)).toEqual(["A", "B"]);
    const calls = ctx.repository.currentCalls;

    const result = await ctx.service.reorder(admin, "regular", [c, a, b], at(1_000));
    expect(result).toEqual({ order: [c, a, b] });
    expect(await titles(ctx, admin)).toEqual([["C", 0], ["A", 1], ["B", 2]]);
    expect((await ctx.service.forPlayer(facts(), at(2_000))).map((slide) => slide.title)).toEqual(["C", "A"]);
    expect(ctx.repository.currentCalls).toBeGreaterThan(calls);
  });

  it("одна запись аудита с названиями до и после; цель — группа", async () => {
    const ctx = setup();
    const admin = await person(ctx, "704", "admin");
    const [a, b, c] = await three(ctx, admin);
    const before = ctx.roles.entries.length;
    await ctx.service.reorder(admin, "regular", [c, a, b], at(1_000));
    expect(ctx.roles.entries).toHaveLength(before + 1);
    expect(ctx.roles.entries.at(-1)).toMatchObject({
      actorAccountId: admin.accountId,
      action: "home.slides.reorder",
      target: "regular",
      before: { order: ["A", "B", "C"] },
      after: { order: ["C", "A", "B"] },
    });
  });

  it("тот же порядок повторно: ответ тот же, аудита нет, ничего не записано", async () => {
    const ctx = setup();
    const admin = await person(ctx, "705", "admin");
    const [a, b, c] = await three(ctx, admin);
    const updatedAt = ctx.repository.rows.map((row) => row.updatedAt);
    const before = ctx.roles.entries.length;
    expect(await ctx.service.reorder(admin, "regular", [a, b, c], at(HOUR))).toEqual({ order: [a, b, c] });
    expect(ctx.roles.entries).toHaveLength(before);
    expect(ctx.repository.rows.map((row) => row.updatedAt)).toEqual(updatedAt);
    await ctx.service.reorder(admin, "regular", [c, b, a], at(HOUR));
    const second = ctx.roles.entries.length;
    await ctx.service.reorder(admin, "regular", [c, b, a], at(2 * HOUR));
    expect(ctx.roles.entries).toHaveLength(second);
  });

  it("не тот состав — 400 «team_slide_order_mismatch», ничего не записано и аудита нет", async () => {
    const ctx = setup();
    const admin = await person(ctx, "706", "admin");
    const [a, b, c] = await three(ctx, admin);
    const pinned = await ctx.service.create(admin, input({ title: "З", pinned: true }), NOW);
    const archived = await ctx.service.create(admin, input({ title: "Снятый" }), NOW);
    await ctx.service.archive(admin, archived.slideId, NOW);
    const entries = ctx.roles.entries.length;

    const bad: [string, string[]][] = [
      ["не хватает одного", [c, a]],
      ["неизвестный id", [c, a, randomUUID()]],
      ["слайд другой группы", [c, a, pinned.slideId]],
      ["снятый слайд", [c, a, b, archived.slideId]],
      ["повтор", [c, c, a]],
      ["лишний", [c, a, b, randomUUID()]],
    ];
    for (const [name, ids] of bad) {
      expect(await codeOf(ctx.service.reorder(admin, "regular", ids, at(HOUR))), name).toBe("team_slide_order_mismatch");
    }
    expect(await titles(ctx, admin)).toEqual([["З", 0], ["A", 0], ["B", 1], ["C", 2], ["Снятый", 3]]);
    expect(ctx.roles.entries).toHaveLength(entries);
    expect(await codeOf(ctx.service.reorder(admin, "pinned", [a], at(HOUR)))).toBe("team_slide_order_mismatch");
  });

  it("кончившийся и будущий слайды входят в порядок своей группы", async () => {
    const ctx = setup();
    const admin = await person(ctx, "707", "admin");
    const now = at(10 * DAY);
    const ended = row({ title: "кончился", startsAt: at(0), endsAt: at(DAY), position: 0 });
    const future = row({ title: "будет", startsAt: at(20 * DAY), endsAt: at(21 * DAY), position: 1 });
    const active = row({ title: "идёт", startsAt: at(9 * DAY), endsAt: at(12 * DAY), position: 2 });
    ctx.repository.rows.push(ended, future, active);
    const result = await ctx.service.reorder(admin, "regular", [active.slideId, future.slideId, ended.slideId], now);
    expect(result.order).toEqual([active.slideId, future.slideId, ended.slideId]);
    expect((await ctx.service.catalog(admin, now)).slides.map((slide) => slide.title)).toEqual(["идёт", "будет", "кончился"]);
  });

  it("без home.edit — тот же отказ, что у заведения, и порядок прежний", async () => {
    const ctx = setup();
    const admin = await person(ctx, "708", "admin");
    const [a, b, c] = await three(ctx, admin);
    const outsider = await person(ctx, "709", "moderator");
    expect(await codeOf(ctx.service.create(outsider, input(), NOW))).toBe("forbidden");
    expect(await codeOf(ctx.service.reorder(outsider, "regular", [c, b, a], NOW))).toBe("forbidden");
    expect(await titles(ctx, admin)).toEqual([["A", 0], ["B", 1], ["C", 2]]);
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

    const updated = await app.inject({ method: "POST", url: `${url}/${slideId}`, headers, payload: { ...payload, title: "Турнир" } });
    expect(updated.statusCode).toBe(201);
    expect(updated.json<{ data: { title: string } }>().data.title).toBe("Турнир");
    expect((await app.inject({ method: "POST", url: `${url}/не-uuid`, headers, payload })).statusCode).toBe(400);

    // Порядок: «order» — не id слайда, неполный набор — 400, без права — 403.
    const secondId = (await app.inject({ method: "POST", url, headers, payload: { ...payload, title: "Конкурс" } })).json<{ data: { slideId: string } }>().data.slideId;
    const orderUrl = `${url}/order`;
    const reordered = await app.inject({ method: "POST", url: orderUrl, headers, payload: { group: "regular", ids: [secondId, slideId] } });
    expect(reordered.statusCode).toBe(201);
    expect(reordered.json<{ data: { order: string[] } }>().data.order).toEqual([secondId, slideId]);
    const listed = await app.inject({ method: "GET", url, headers });
    expect(listed.json<{ data: { slides: { slideId: string; position: number }[] } }>().data.slides.map((slide) => [slide.slideId, slide.position])).toEqual([[secondId, 0], [slideId, 1]]);
    const partial = await app.inject({ method: "POST", url: orderUrl, headers, payload: { group: "regular", ids: [secondId] } });
    expect(partial.statusCode).toBe(400);
    expect(partial.json<{ error: { code: string } }>().error.code).toBe("team_slide_order_mismatch");
    expect((await app.inject({ method: "POST", url: orderUrl, headers, payload: { group: "other", ids: [secondId] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: orderUrl, headers: { cookie }, payload: { group: "regular", ids: [secondId, slideId] } })).statusCode).toBe(403);
    // Роль без home.edit: сессия есть, права нет.
    await person(ctx, "dev-player-910", "moderator");
    const outsiderLogin = await app.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: "dev-player-910:Модератор" } });
    const outsiderCookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(outsiderLogin.headers["set-cookie"]))?.[1] ?? ""}`;
    const outsider = await app.inject({ method: "POST", url: orderUrl, headers: { cookie: outsiderCookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE }, payload: { group: "regular", ids: [secondId, slideId] } });
    expect(outsider.statusCode).toBe(403);

    const archived = await app.inject({ method: "POST", url: `${url}/${slideId}/archive`, headers });
    expect(archived.statusCode).toBe(201);
    expect(archived.json<{ data: { state: string } }>().data.state).toBe("archived");
    expect((await app.inject({ method: "POST", url: `${url}/${randomUUID()}/archive`, headers })).statusCode).toBe(404);
  });
});
