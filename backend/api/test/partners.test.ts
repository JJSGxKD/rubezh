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
import type { PartnerFunnelRow } from "../src/modules/funnel/funnel-report.js";
import { PARTNER_STATUSES, bindsNewPlayers, partnerInputSchema, withinBindWindow } from "../src/modules/partners/partner-rules.js";
import { PartnersService } from "../src/modules/partners/partners.service.js";
import type { PartnerFunnelSource } from "../src/modules/funnel/funnel.repository.js";
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

describe("условия партнёра", () => {
  const base = { name: "Канал", contact: null, note: null };

  it("TG id, страна, валюта, способ выплаты и процент: пробелы срезаются, процент — с двумя знаками", () => {
    expect(
      partnerInputSchema.parse({ ...base, telegramId: " 123456789 ", country: "RU", payoutCurrency: "USDT", payoutMethod: " USDT TRC-20 на T9yX… ", sharePercent: "12.5" }),
    ).toEqual({ ...base, telegramId: "123456789", country: "RU", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX…", sharePercent: "12.50" });
    // Граничные значения проходят: двадцать цифр, ноль и сто процентов, любая валюта ядра курсов.
    for (const good of [{ telegramId: "1".repeat(20) }, { sharePercent: "0" }, { sharePercent: "100" }, { sharePercent: "100.00" }, { sharePercent: "007.5" }, { payoutCurrency: "GRAM" }, { payoutMethod: "x".repeat(200) }]) {
      expect(partnerInputSchema.safeParse({ ...base, ...good }).success, JSON.stringify(good)).toBe(true);
    }
  });

  it("пустые строки и null — null; не названное не появляется, чтобы правка без них ничего не стирала", () => {
    expect(partnerInputSchema.parse({ ...base, telegramId: "", country: "", payoutCurrency: "", payoutMethod: "  ", sharePercent: "" })).toEqual({
      ...base,
      telegramId: null,
      country: null,
      payoutCurrency: null,
      payoutMethod: null,
      sharePercent: null,
    });
    expect(partnerInputSchema.parse({ ...base, telegramId: null, sharePercent: null })).toEqual({ ...base, telegramId: null, sharePercent: null });
    expect(partnerInputSchema.parse(base)).toEqual(base);
  });

  it("отказ: TG id с буквами или длиннее двадцати цифр, страна не двумя заглавными, неизвестная валюта, процент не от 0 до 100", () => {
    const bad = [
      { telegramId: "12ab" },
      { telegramId: "1".repeat(21) },
      { telegramId: "-5" },
      { country: "ru" },
      { country: "RUS" },
      { country: "Р" },
      { payoutCurrency: "EURO" },
      { payoutCurrency: "usd" },
      { payoutCurrency: "BTC" },
      { payoutMethod: "x".repeat(201) },
      { sharePercent: "100.01" },
      { sharePercent: "101" },
      { sharePercent: "1000" },
      { sharePercent: "abc" },
      { sharePercent: "12.345" },
      { sharePercent: "-1" },
      { sharePercent: ".5" },
      { sharePercent: "5." },
    ];
    for (const patch of bad) expect(partnerInputSchema.safeParse({ ...base, ...patch }).success, JSON.stringify(patch)).toBe(false);
    // Статус в общей форме не меняется: отдельная ручка, с причиной.
    expect(partnerInputSchema.safeParse({ ...base, status: "paused" }).success).toBe(false);
  });

  it("четыре статуса; новых игроков привязывает только активный", () => {
    expect(PARTNER_STATUSES).toEqual(["applied", "active", "paused", "rejected"]);
    for (const status of PARTNER_STATUSES) expect(bindsNewPlayers(status), status).toBe(status === "active");
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

  it("партнёр с условиями: по умолчанию активен, всё записано и видно в карточке; без условий — null", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "110", "marketer");
    const plain = await ctx.service.create(marketer, { name: "Без условий", contact: null, note: null }, NOW);
    expect(plain).toMatchObject({ status: "active", telegramId: null, country: null, payoutCurrency: null, payoutMethod: null, sharePercent: null });

    const full = await ctx.service.create(
      marketer,
      { name: "С условиями", contact: "@deal", note: null, telegramId: "424242", country: "KZ", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX", sharePercent: "15.00" },
      NOW,
    );
    expect(full).toMatchObject({ status: "active", telegramId: "424242", country: "KZ", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX", sharePercent: "15.00" });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "partner.create", after: { telegramId: "424242", sharePercent: "15.00", status: "active" } });
    expect((await ctx.service.detail(marketer, full.partnerId, NOW)).partner).toMatchObject({ telegramId: "424242", country: "KZ" });
  });

  it("правка: в аудит — только изменённые поля «было → стало», смена страны и валюты видна; не названное не стирается", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "120", "marketer");
    const created = await ctx.service.create(marketer, { name: "Блогер", contact: "@blog", note: null, country: "RU", payoutCurrency: "RUB", sharePercent: "10.00" }, NOW);

    const changed = await ctx.service.update(marketer, created.partnerId, { name: "Блогер", contact: "@blog", note: null, country: "KZ", payoutCurrency: "USDT", sharePercent: null }, NOW);
    expect(ctx.roles.entries.at(-1)).toMatchObject({
      action: "partner.update",
      target: created.partnerId,
      before: { country: "RU", payoutCurrency: "RUB", sharePercent: "10.00" },
      after: { country: "KZ", payoutCurrency: "USDT", sharePercent: null },
    });
    expect(Object.keys(ctx.roles.entries.at(-1)?.after as object).sort()).toEqual(["country", "payoutCurrency", "sharePercent"]);
    expect(changed).toMatchObject({ country: "KZ", payoutCurrency: "USDT", sharePercent: null, contact: "@blog" });

    // Правка без полей условий их не трогает: форма старой версии ничего не стирает.
    const again = await ctx.service.update(marketer, created.partnerId, { name: "Блогер 2", contact: "@blog", note: null }, NOW);
    expect(again).toMatchObject({ name: "Блогер 2", country: "KZ", payoutCurrency: "USDT" });
  });

  it("TG id уникален среди партнёров: второй получает 409 с именем первого; свой же id — не конфликт", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "130", "marketer");
    const first = await ctx.service.create(marketer, { name: "Первый", contact: null, note: null, telegramId: "5550001" }, NOW);

    const clash = ctx.service.create(marketer, { name: "Второй", contact: null, note: null, telegramId: "5550001" }, NOW);
    expect(await codeOf(clash)).toBe("partner_telegram_taken");
    await expect(ctx.service.create(marketer, { name: "Второй", contact: null, note: null, telegramId: "5550001" }, NOW)).rejects.toMatchObject({
      status: 409,
      message: "Этот TG id уже у партнёра «Первый»",
    });

    const second = await ctx.service.create(marketer, { name: "Второй", contact: null, note: null }, NOW);
    expect(await codeOf(ctx.service.update(marketer, second.partnerId, { name: "Второй", contact: null, note: null, telegramId: "5550001" }, NOW))).toBe("partner_telegram_taken");
    // Свой TG id той же формой — правка как правка; другой партнёр с другим id тоже.
    expect(await ctx.service.update(marketer, first.partnerId, { name: "Первый", contact: null, note: "ок", telegramId: "5550001" }, NOW)).toMatchObject({ telegramId: "5550001", note: "ок" });
    expect(await ctx.service.update(marketer, second.partnerId, { name: "Второй", contact: null, note: null, telegramId: "5550002" }, NOW)).toMatchObject({ telegramId: "5550002" });
  });

  it("смена статуса: только с partners.edit, причина от трёх до двухсот знаков, в аудит «было → стало» с причиной", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "140", "marketer");
    const partner = await ctx.service.create(marketer, { name: "Канал", contact: null, note: null }, NOW);

    const finance = await person(ctx, "141", "finance");
    expect(await codeOf(ctx.service.setStatus(finance, partner.partnerId, "paused", "Не выходит на связь", NOW))).toBe("forbidden");
    const moderator = await person(ctx, "142", "moderator");
    expect(await codeOf(ctx.service.setStatus(moderator, partner.partnerId, "paused", "Не выходит на связь", NOW))).toBe("forbidden");

    for (const reason of ["", "ок", "  я ", "x".repeat(201)]) {
      expect(await codeOf(ctx.service.setStatus(marketer, partner.partnerId, "paused", reason, NOW)), JSON.stringify(reason)).toBe("validation_failed");
    }
    expect((await ctx.service.detail(marketer, partner.partnerId, NOW)).partner.status).toBe("active");

    const paused = await ctx.service.setStatus(marketer, partner.partnerId, "paused", "  Не выходит на связь  ", NOW);
    expect(paused.status).toBe("paused");
    expect(ctx.roles.entries.at(-1)).toEqual(
      expect.objectContaining({ action: "partner.status", target: partner.partnerId, actorAccountId: marketer.accountId, before: { status: "active" }, after: { status: "paused", reason: "Не выходит на связь" } }),
    );
    expect((await ctx.service.catalog(marketer, NOW)).partners[0]?.status).toBe("paused");

    expect(await codeOf(ctx.service.setStatus(marketer, randomUUID(), "active", "Нет такого", NOW))).toBe("partner_not_found");
  });

  it("смена статуса прежних привязок не трогает: приведённые остаются за партнёром при любом статусе", async () => {
    const ctx = setup();
    const admin = await person(ctx, "150", "admin");
    const partner = await ctx.service.create(admin, { name: "Блогер", contact: null, note: null }, NOW);
    const campaignId = "33333333-3333-4333-8333-333333333333";
    await ctx.promo.create(
      { campaignId, title: "Код", kind: "shared", reward: { coins: 100, gems: 0, shard_common: 0, shard_uncommon: 0 }, message: null, maxRedemptions: null, newPlayersDays: null, platforms: [], note: null, partnerId: partner.partnerId, createdBy: admin.accountId, createdAt: NOW, startsAt: new Date(NOW.getTime() - DAY), endsAt: null },
      [{ code: "BLOG9", display: "BLOG9" }],
      null,
    );
    for (const accountId of ["a", "b", "c"]) await ctx.promo.redeem({ campaignId, accountId, code: "BLOG9", batch: false, partnerId: partner.partnerId, at: NOW });

    for (const status of ["paused", "rejected", "applied", "active"] as const) {
      await ctx.service.setStatus(admin, partner.partnerId, status, "Смена для проверки", NOW);
      expect((await ctx.service.detail(admin, partner.partnerId, NOW)).partner.stats.bound, status).toBe(3);
    }
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

describe("воронка партнёра (T-0068, Р96)", () => {
  const NOW_PERIOD = { from: new Date(NOW.getTime() - 30 * DAY), to: NOW };
  const counts = (patch: Partial<PartnerFunnelRow> = {}) => ({ accounts: 0, entered: 0, appOpened: 0, firstRunStarted: 0, firstRunFinished: 0, runs2: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0, ...patch });

  class Source implements PartnerFunnelSource {
    rows: PartnerFunnelRow[] = [];
    readonly asked: { partnerId: string; from: Date; to: Date }[] = [];
    async partnerReport(partnerId: string, from: Date, to: Date): Promise<PartnerFunnelRow[]> {
      this.asked.push({ partnerId, from, to });
      return this.rows;
    }
  }

  function withFunnel() {
    const ctx = setup();
    const source = new Source();
    const service = new PartnersService(ctx.repository, new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv), ctx.roles, ctx.accounts), null, source);
    return { ...ctx, service, source };
  }

  async function partnerOf(ctx: ReturnType<typeof withFunnel>): Promise<string> {
    const admin = await person(ctx, "800", "admin");
    return (await ctx.service.create(admin, { name: "Канал", contact: null, note: null }, NOW)).partnerId;
  }

  it("без partners.view — отказ; бухгалтерия и маркетолог видят; партнёра нет — 404", async () => {
    const ctx = withFunnel();
    const partnerId = await partnerOf(ctx);
    const moderator = await person(ctx, "801", "moderator");
    const finance = await person(ctx, "802", "finance");
    const marketer = await person(ctx, "803", "marketer");

    expect(await codeOf(ctx.service.funnel(moderator, partnerId, NOW_PERIOD.from, NOW_PERIOD.to))).toBe("forbidden");
    await expect(ctx.service.funnel(finance, partnerId, NOW_PERIOD.from, NOW_PERIOD.to)).resolves.toBeDefined();
    await expect(ctx.service.funnel(marketer, partnerId, NOW_PERIOD.from, NOW_PERIOD.to)).resolves.toBeDefined();
    expect(await codeOf(ctx.service.funnel(marketer, randomUUID(), NOW_PERIOD.from, NOW_PERIOD.to))).toBe("partner_not_found");
    // Партнёра нет — до базы воронки не доходит.
    expect(ctx.source.asked).toHaveLength(2);
  });

  it("период 400 суток — 400; ровно 366 — можно; обратный порядок и нулевой период — 400", async () => {
    const ctx = withFunnel();
    const partnerId = await partnerOf(ctx);
    const marketer = await person(ctx, "804", "marketer");
    const to = NOW;

    expect(await codeOf(ctx.service.funnel(marketer, partnerId, new Date(to.getTime() - 400 * DAY), to))).toBe("validation_failed");
    await expect(ctx.service.funnel(marketer, partnerId, new Date(to.getTime() - 366 * DAY), to)).resolves.toBeDefined();
    expect(await codeOf(ctx.service.funnel(marketer, partnerId, to, new Date(to.getTime() - DAY)))).toBe("validation_failed");
    expect(await codeOf(ctx.service.funnel(marketer, partnerId, to, to))).toBe("validation_failed");
  });

  it("ответ: все игроки партнёра, источники привязки и площадки; период и партнёр доходят до источника данных", async () => {
    const ctx = withFunnel();
    const partnerId = await partnerOf(ctx);
    const marketer = await person(ctx, "805", "marketer");
    ctx.source.rows = [
      { platform: "telegram", via: "link", viaName: "channel-post", viaRef: "AbCd1234", ...counts({ accounts: 2, entered: 2, appOpened: 2, firstRunStarted: 1, firstRunFinished: 1 }) },
      { platform: "vk", via: "link", viaName: "channel-post", viaRef: "AbCd1234", ...counts({ accounts: 1, entered: 1, appOpened: 1 }) },
      { platform: "telegram", via: "code", viaName: "Стрим", viaRef: "11111111-1111-4111-8111-111111111111", ...counts({ accounts: 1, entered: 1, appOpened: 1, firstRunStarted: 1, runs2: 1, firstPurchase: 1 }) },
    ];

    const view = await ctx.service.funnel(marketer, partnerId, NOW_PERIOD.from, NOW_PERIOD.to);

    expect(ctx.source.asked).toEqual([{ partnerId, from: NOW_PERIOD.from, to: NOW_PERIOD.to }]);
    expect(view.from).toBe(NOW_PERIOD.from.toISOString());
    expect(view.to).toBe(NOW_PERIOD.to.toISOString());
    expect(view.total).toEqual(counts({ accounts: 4, entered: 4, appOpened: 4, firstRunStarted: 2, firstRunFinished: 1, runs2: 1, firstPurchase: 1 }));
    // Источник — ссылка или код, а не площадка: ссылка с двух площадок — одна строка.
    expect(view.sources).toEqual([
      { via: "link", name: "channel-post", ref: "AbCd1234", counts: counts({ accounts: 3, entered: 3, appOpened: 3, firstRunStarted: 1, firstRunFinished: 1 }) },
      { via: "code", name: "Стрим", ref: "11111111-1111-4111-8111-111111111111", counts: counts({ accounts: 1, entered: 1, appOpened: 1, firstRunStarted: 1, runs2: 1, firstPurchase: 1 }) },
    ]);
    expect(view.platforms.map((row) => [row.platform, row.counts.accounts])).toEqual([["telegram", 3], ["vk", 1]]);
  });

  it("нет привязок — нули и пустые списки; без источника данных сервис отвечает пустой воронкой", async () => {
    const ctx = withFunnel();
    const partnerId = await partnerOf(ctx);
    const marketer = await person(ctx, "806", "marketer");

    const empty = await ctx.service.funnel(marketer, partnerId, NOW_PERIOD.from, NOW_PERIOD.to);
    expect(empty).toMatchObject({ total: counts(), sources: [], platforms: [] });

    const bare = setup();
    const admin = await person(bare, "807", "admin");
    const created = await bare.service.create(admin, { name: "Без воронки", contact: null, note: null }, NOW);
    expect((await bare.service.funnel(admin, created.partnerId, NOW_PERIOD.from, NOW_PERIOD.to)).total).toEqual(counts());
  });

  it("источники по убыванию игроков, при равенстве по названию; ссылка без названия — после названных", async () => {
    const ctx = withFunnel();
    const partnerId = await partnerOf(ctx);
    const marketer = await person(ctx, "808", "marketer");
    const row = (via: "link" | "code", viaName: string | null, viaRef: string | null, accounts: number): PartnerFunnelRow => ({ platform: "telegram", via, viaName, viaRef, ...counts({ accounts, entered: accounts }) });
    ctx.source.rows = [row("code", null, null, 1), row("link", "б-пост", "B1", 2), row("link", "а-пост", "A1", 2), row("code", "Стрим", "C1", 5)];

    const view = await ctx.service.funnel(marketer, partnerId, NOW_PERIOD.from, NOW_PERIOD.to);

    expect(view.sources.map((source) => source.name)).toEqual(["Стрим", "а-пост", "б-пост", null]);
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

  it("условия и статус по HTTP: поля условий в теле и ответе, PUT /:id/status с причиной; мусор — 400, занятый TG id — 409", async () => {
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
    const terms = { telegramId: "900100", country: "KZ", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX", sharePercent: "12.5" };
    const payload = { name: "Канал", contact: "@channel", note: null, ...terms };

    for (const bad of [{ telegramId: "abc" }, { country: "kz" }, { payoutCurrency: "BTC" }, { sharePercent: "100.5" }, { status: "paused" }]) {
      expect((await app.inject({ method: "POST", url: base, headers, payload: { ...payload, ...bad } })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const created = await app.inject({ method: "POST", url: base, headers, payload });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ data: unknown }>().data).toMatchObject({ status: "active", telegramId: "900100", country: "KZ", payoutCurrency: "USDT", sharePercent: "12.50" });
    const partnerId = created.json<{ data: { partnerId: string } }>().data.partnerId;

    const other = await app.inject({ method: "POST", url: base, headers, payload: { name: "Другой", contact: null, note: null } });
    const taken = await app.inject({ method: "POST", url: `${base}/${other.json<{ data: { partnerId: string } }>().data.partnerId}`, headers, payload: { name: "Другой", contact: null, note: null, telegramId: "900100" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: { code: string; message: string } }>().error).toEqual({ code: "partner_telegram_taken", message: "Этот TG id уже у партнёра «Канал»" });

    const url = `${base}/${partnerId}/status`;
    const body = { status: "paused", reason: "Не выходит на связь" };
    expect((await app.inject({ method: "PUT", url, headers: { cookie }, payload: body })).statusCode).toBe(403);
    for (const bad of [{ ...body, status: "banned" }, { ...body, reason: "ок" }, { status: "paused" }, { ...body, extra: 1 }]) {
      expect((await app.inject({ method: "PUT", url, headers, payload: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: `${base}/не-uuid/status`, headers, payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `${base}/${randomUUID()}/status`, headers, payload: body })).statusCode).toBe(404);
    const paused = await app.inject({ method: "PUT", url, headers, payload: body });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<{ data: { status: string } }>().data.status).toBe("paused");
    expect((await app.inject({ method: "GET", url: `${base}/${partnerId}`, headers })).json<{ data: { partner: { status: string } } }>().data.partner.status).toBe("paused");
  });
  it("GET /:id/funnel: период по умолчанию — тридцать суток; свой период; 400 на кривые даты и период дольше года; 404 без партнёра; 403 без права", async () => {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup(cfg);
    const asked: { from: Date; to: Date }[] = [];
    const source: PartnerFunnelSource = {
      partnerReport: async (_partnerId, from, to) => {
        asked.push({ from, to });
        return [];
      },
    };
    const service = new PartnersService(ctx.repository, new RolesService(cfg, ctx.roles, ctx.accounts), null, source);
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
        { provide: PartnersService, useValue: service },
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
    const created = await app.inject({ method: "POST", url: base, headers, payload: { name: "Канал", contact: null, note: null } });
    const partnerId = created.json<{ data: { partnerId: string } }>().data.partnerId;

    const byDefault = await app.inject({ method: "GET", url: `${base}/${partnerId}/funnel`, headers });
    expect(byDefault.statusCode).toBe(200);
    expect(byDefault.json<{ data: { total: { accounts: number }; sources: unknown[]; platforms: unknown[] } }>().data).toMatchObject({ total: { accounts: 0 }, sources: [], platforms: [] });
    const first = asked[0];
    expect(first === undefined ? 0 : Math.round((first.to.getTime() - first.from.getTime()) / DAY)).toBe(30);

    const own = await app.inject({ method: "GET", url: `${base}/${partnerId}/funnel?from=2026-09-01T00:00:00.000Z&to=2026-09-08T00:00:00.000Z`, headers });
    expect(own.statusCode).toBe(200);
    expect(asked[1]).toEqual({ from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-08T00:00:00.000Z") });

    expect((await app.inject({ method: "GET", url: `${base}/${partnerId}/funnel?from=не-дата`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/${partnerId}/funnel?from=2025-01-01T00:00:00.000Z&to=2026-09-08T00:00:00.000Z`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/${partnerId}/funnel?from=2026-09-08T00:00:00.000Z&to=2026-09-01T00:00:00.000Z`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/${randomUUID()}/funnel`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${base}/не-uuid/funnel`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/${partnerId}/funnel` })).statusCode).toBe(401);
  });
});
