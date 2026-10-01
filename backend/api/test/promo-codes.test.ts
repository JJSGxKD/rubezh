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
import { AdminPromoCodesController } from "../src/modules/admin/admin-promo-codes.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import {
  BATCH_ALPHABET,
  PROMO_CODE_LIMITS,
  batchCode,
  campaignState,
  codeDisplay,
  codeKey,
  codeProblem,
  prefixProblem,
  promoCampaignInputSchema,
  redeemRefusal,
  updateProblem,
  type PromoCampaignInput,
  type PromoCampaignRow,
  type PromoCampaignUpdate,
} from "../src/modules/promo-codes/promo-code-rules.js";
import { PromoCodesController } from "../src/modules/promo-codes/promo-codes.controller.js";
import { PromoCodesService, type PromoRandom } from "../src/modules/promo-codes/promo-codes.service.js";
import { ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryPromoCodesRepository } from "./helpers/memory-promo-codes.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Промокоды (docs/35-stage4-plan.md WP41, Р74): код набирают с любой
 * раскладки и в любом регистре; кампания активируется игроком однажды;
 * срок, лимит, площадки и «только новичкам» проверяет сервер; награда
 * ложится ключами по кампании и игроку, и не легшая доначисляется повторным
 * вводом. Кампании заводит команда под своим правом, с аудитом.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 2, 9));
const OWNER_ID = "777000333";

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

/** Кошелёк в памяти с суточным потолком — как настоящий, без базы. */
class FakeWallet {
  readonly grants: GrantInput[] = [];
  readonly keys = new Map<string, number>();
  /** потолок на ресурс за весь тест — чтобы проверить срезанную награду */
  cap: Partial<Record<string, number>> = {};
  private readonly spent = new Map<string, number>();

  async grant(input: GrantInput): Promise<GrantResult> {
    const existing = this.keys.get(input.idempotencyKey);
    if (existing !== undefined) return { credited: existing, balance: 0, duplicate: true };
    const used = this.spent.get(input.resource) ?? 0;
    const room = Math.max(0, (this.cap[input.resource] ?? Infinity) - used);
    const credited = Math.min(input.amount, room);
    this.spent.set(input.resource, used + credited);
    this.keys.set(input.idempotencyKey, credited);
    this.grants.push(input);
    return { credited, balance: 0, duplicate: false };
  }
}

/** Предсказуемый «случай»: коды пачки идут по порядку, с заданными повторами. */
function sequence(values: readonly number[]): PromoRandom {
  let index = 0;
  return (size) => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value % size;
  };
}

let counter = 0;
const counting: PromoRandom = (size) => {
  counter += 1;
  return counter % size;
};

function setup(options: { pick?: PromoRandom; config?: ReturnType<typeof loadAppConfig> } = {}) {
  const config = options.config ?? loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const repository = new MemoryPromoCodesRepository();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const wallet = new FakeWallet();
  const service = new PromoCodesService(repository, accounts, options.pick ?? counting, wallet as unknown as WalletService, new RolesService(config, roles, accounts));
  return { repository, accounts, roles, wallet, service, config };
}

type Ctx = ReturnType<typeof setup>;

async function person(ctx: Ctx, id: string, options: { role?: "admin" | "marketer" | "game_designer" | "moderator" | "finance"; createdAt?: Date; platform?: "telegram" | "vk" } = {}): Promise<AccountRef> {
  const platform = options.platform ?? "telegram";
  const account = await ctx.accounts.upsert({ platform, platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, (options.createdAt ?? at(-30 * DAY)).getTime());
  if (options.role !== undefined) await ctx.roles.grant(account.accountId, options.role, null);
  return { accountId: account.accountId, platform, platformUserId: id };
}

function input(patch: Partial<PromoCampaignInput> = {}): PromoCampaignInput {
  return {
    title: "Стрим 12 октября",
    note: null,
    message: "Спасибо, что смотрели стрим!",
    reward: { coins: 1_000, gems: 20, shard_common: 0, shard_uncommon: 0 },
    startsAt: NOW,
    endsAt: at(7 * DAY),
    newPlayersDays: null,
    platforms: [],
    issue: { kind: "shared", code: "Рубеж 2026", maxRedemptions: null },
    ...patch,
  };
}

function row(patch: Partial<PromoCampaignRow> = {}): PromoCampaignRow {
  return {
    campaignId: randomUUID(),
    title: "Код",
    kind: "shared",
    reward: { coins: 500, gems: 0, shard_common: 0, shard_uncommon: 0 },
    message: null,
    maxRedemptions: null,
    redeemed: 0,
    startsAt: at(-DAY),
    endsAt: at(DAY),
    newPlayersDays: null,
    platforms: [],
    pausedAt: null,
    note: null,
    createdBy: randomUUID(),
    createdAt: at(-DAY),
    updatedAt: at(-DAY),
    codeSample: "RUBEZH",
    ...patch,
  };
}

function updateOf(current: PromoCampaignRow, patch: Partial<PromoCampaignUpdate> = {}): PromoCampaignUpdate {
  return {
    title: current.title,
    note: current.note,
    message: current.message,
    reward: current.reward,
    startsAt: current.startsAt,
    endsAt: current.endsAt,
    newPlayersDays: current.newPlayersDays,
    platforms: current.platforms,
    maxRedemptions: current.maxRedemptions,
    ...patch,
  };
}

describe("ключ кода: набирается как угодно", () => {
  it("регистр, пробелы, дефисы, подчёркивания и точки не важны", () => {
    const key = codeKey("RUBEZH2026");
    for (const typed of ["rubezh2026", "Rubezh 2026", "RUBEZH-2026", " rubezh_2026 ", "r.u.b.e.z.h.2026"]) expect(codeKey(typed), typed).toBe(key);
  });

  it("кириллица-двойник сводится к латинице, Ё — к Е: «РЕКА» на русской раскладке — это «PEKA»", () => {
    expect(codeKey("река")).toBe(codeKey("PEKA"));
    expect(codeKey("ёлка")).toBe(codeKey("ЕЛКА"));
    // Русское слово остаётся русским: «ЗИМА» и «ZIMA» — разные коды.
    expect(codeKey("зима")).not.toBe(codeKey("ZIMA"));
    expect(codeKey("Рубеж 2026")).toBe(codeKey("РУБЕЖ-2026"));
  });

  it("запись кода: буквы и цифры, группы через пробел или дефис; длина — без разделителей", () => {
    expect(codeDisplay("  рубеж   2026 ")).toBe("РУБЕЖ 2026");
    expect(codeProblem("Рубеж 2026")).toBeNull();
    expect(codeProblem("ZIMA-2026")).toBeNull();
    expect(codeProblem("ABC")).toMatch(/Не короче 4/);
    expect(codeProblem("A".repeat(25))).toMatch(/Не длиннее 24/);
    expect(codeProblem("A-B-C-D")).toBeNull();
    for (const bad of ["ZIMA!", "ZIMA--2026", "-ZIMA", "ZIMA_2026", "ЗИМА😀", ""]) expect(codeProblem(bad), bad).not.toBeNull();
  });

  it("приставка пачки — одно слово до восьми знаков; пусто — можно", () => {
    expect(prefixProblem("")).toBeNull();
    expect(prefixProblem("zima")).toBeNull();
    expect(prefixProblem("ЗИМА2026")).toBeNull();
    expect(prefixProblem("ZIMA 26")).not.toBeNull();
    expect(prefixProblem("ABCDEFGHI")).not.toBeNull();
  });

  it("код пачки — из букв, которые есть на обеих раскладках, и цифр без двойников", () => {
    for (const letter of "OI01B8") expect(BATCH_ALPHABET.includes(letter), letter).toBe(false);
    for (const letter of BATCH_ALPHABET) {
      // Каждая буква набирается и с русской раскладки: её кириллический двойник сводится к ней же.
      if (/[A-Z]/.test(letter)) expect(Object.values({ А: "A", С: "C", Е: "E", Н: "H", К: "K", М: "M", Р: "P", Т: "T", Х: "X", У: "Y" })).toContain(letter);
    }
    const { code, display } = batchCode("zima", sequence([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(display).toBe("ZIMA-ACEH-KMPT");
    expect(code).toBe("ZIMAACEHKMPT");
    expect(batchCode("", sequence([16])).display).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // Набранный на русской раскладке код пачки находится.
    expect(codeKey("зима-асен-кмрт")).toBe(codeKey("ZIMA-ACEH-KMPT").replace("ZIMA", codeKey("ЗИМА")));
  });
});

describe("правила кампании", () => {
  it("состояние: конец срока сильнее паузы, лимит — сильнее паузы, пауза — сильнее «ещё не начался»", () => {
    expect(campaignState(row(), NOW)).toBe("active");
    expect(campaignState(row({ startsAt: at(HOUR) }), NOW)).toBe("scheduled");
    expect(campaignState(row({ pausedAt: at(-HOUR) }), NOW)).toBe("paused");
    expect(campaignState(row({ pausedAt: at(-HOUR), startsAt: at(HOUR) }), NOW)).toBe("paused");
    expect(campaignState(row({ endsAt: NOW, pausedAt: at(-HOUR) }), NOW)).toBe("expired");
    expect(campaignState(row({ maxRedemptions: 3, redeemed: 3, pausedAt: at(-HOUR) }), NOW)).toBe("exhausted");
    expect(campaignState(row({ endsAt: null }), at(1_000 * DAY))).toBe("active");
  });

  it("отказ игроку — от главного: кончился, чужой код пачки, лимит, пауза, не начался, площадка, новичкам", () => {
    const player = { platform: "telegram" as const, createdAt: at(-30 * DAY) };
    const free = { redeemedBy: null };
    expect(redeemRefusal(row(), free, player, NOW)).toBeNull();
    expect(redeemRefusal(row({ endsAt: at(-1), pausedAt: at(-DAY) }), { redeemedBy: "x" }, player, NOW)).toBe("expired");
    expect(redeemRefusal(row({ kind: "batch", maxRedemptions: 1, redeemed: 1 }), { redeemedBy: "x" }, player, NOW)).toBe("used");
    expect(redeemRefusal(row({ maxRedemptions: 1, redeemed: 1 }), free, player, NOW)).toBe("exhausted");
    expect(redeemRefusal(row({ pausedAt: at(-1) }), free, player, NOW)).toBe("paused");
    expect(redeemRefusal(row({ startsAt: at(HOUR) }), free, player, NOW)).toBe("scheduled");
    expect(redeemRefusal(row({ platforms: ["vk"] }), free, player, NOW)).toBe("platform");
    expect(redeemRefusal(row({ platforms: ["vk", "telegram"] }), free, player, NOW)).toBeNull();
    expect(redeemRefusal(row({ newPlayersDays: 7 }), free, player, NOW)).toBe("new_players");
    expect(redeemRefusal(row({ newPlayersDays: 7 }), free, { ...player, createdAt: at(-7 * DAY) }, NOW)).toBeNull();
  });

  it("заведение: начало не в прошлом и не дальше 90 дней, срок не короче часа, без награды и сверх потолка — нельзя", () => {
    expect(promoCampaignInputSchema.safeParse({ ...input(), startsAt: NOW.toISOString(), endsAt: null }).success).toBe(true);
    const bad = [
      { reward: { coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 } },
      { reward: { coins: PROMO_CODE_LIMITS.reward.coins + 1, gems: 0, shard_common: 0, shard_uncommon: 0 } },
      { reward: { coins: 10, gems: 0, shard_common: 0, shard_uncommon: 0, shard_rare: 1 } },
      { issue: { kind: "batch", count: PROMO_CODE_LIMITS.batchMax + 1, prefix: "" } },
      { issue: { kind: "batch", count: 0, prefix: "" } },
      { issue: { kind: "shared", code: "RUBEZH", maxRedemptions: 0 } },
      { newPlayersDays: 91 },
      { platforms: ["telegram", "telegram"] },
      { platforms: ["ok"] },
      { title: "x" },
    ];
    for (const patch of bad) {
      expect(promoCampaignInputSchema.safeParse({ ...input(), startsAt: NOW.toISOString(), endsAt: at(DAY).toISOString(), ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("правка: награду — пока никто не активировал, начало — пока не начался, лимит — не ниже активаций, у пачки — не трогать", () => {
    const fresh = row({ startsAt: at(HOUR), endsAt: at(DAY) });
    expect(updateProblem(fresh, updateOf(fresh, { reward: { ...fresh.reward, coins: 5_000 }, startsAt: at(2 * HOUR) }), NOW)).toBeNull();

    const used = row({ redeemed: 4, maxRedemptions: 10 });
    expect(updateProblem(used, updateOf(used, { reward: { ...used.reward, coins: 5_000 } }), NOW)).toMatch(/Награду не поменять/);
    expect(updateProblem(used, updateOf(used, { startsAt: at(-2 * DAY) }), NOW)).toMatch(/уже начал действовать/);
    expect(updateProblem(used, updateOf(used, { maxRedemptions: 3 }), NOW)).toMatch(/не меньше уже сделанных активаций \(4\)/);
    expect(updateProblem(used, updateOf(used, { maxRedemptions: null, title: "Другое название", endsAt: null }), NOW)).toBeNull();
    expect(updateProblem(used, updateOf(used, { endsAt: at(-HOUR) }), NOW)).toMatch(/Конец — в будущем/);

    const batch = row({ kind: "batch", maxRedemptions: 50 });
    expect(updateProblem(batch, updateOf(batch, { maxRedemptions: 60 }), NOW)).toMatch(/У пачки лимит/);
    // Кончившуюся кампанию можно переименовать: конец в прошлом не трогали.
    const ended = row({ endsAt: at(-HOUR) });
    expect(updateProblem(ended, updateOf(ended, { title: "Архив" }), NOW)).toBeNull();
  });
});

describe("кампании в панели", () => {
  it("право — у владельца, администратора и маркетолога; бухгалтерии и геймдизайнеру — нет", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes("promo.edit"))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["admin", "marketer", "owner"]);
  });

  it("маркетолог заводит общий код с аудитом; чужой роли — forbidden", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "100", { role: "marketer" });
    const created = await ctx.service.create(marketer, input(), NOW);
    expect(created).toMatchObject({ kind: "shared", codeSample: "РУБЕЖ 2026", maxRedemptions: null, redeemed: 0, state: "active", remaining: null, createdBy: marketer.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: marketer.accountId, action: "promo.create", target: created.campaignId });

    for (const role of ["game_designer", "moderator", "finance"] as const) {
      const outsider = await person(ctx, `2${role}`, { role });
      expect(await codeOf(ctx.service.create(outsider, input({ issue: { kind: "shared", code: "OTHER1", maxRedemptions: null } }), NOW)), role).toBe("forbidden");
      expect(await codeOf(ctx.service.catalog(outsider, NOW)), role).toBe("forbidden");
    }
  });

  it("занятый код — 409 с названием кампании; занятость не зависит от регистра и раскладки", async () => {
    const ctx = setup();
    const admin = await person(ctx, "300", { role: "admin" });
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "PEKA", maxRedemptions: null } }), NOW);
    let error: unknown = null;
    try {
      await ctx.service.create(admin, input({ title: "Другой", issue: { kind: "shared", code: "река", maxRedemptions: null } }), NOW);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "promo_code_taken", message: expect.stringContaining("«Стрим 12 октября»") as unknown });
    expect(await ctx.service.check(admin, "Peka")).toMatchObject({ key: "PEKA", problem: null, taken: { display: "PEKA", title: "Стрим 12 октября" } });
    expect(await ctx.service.check(admin, "Новый код")).toMatchObject({ display: "НОВЫЙ КОД", problem: null, taken: null });
    expect(await ctx.service.check(admin, "ab!")).toMatchObject({ taken: null, problem: expect.any(String) as unknown });
    expect(await codeOf(ctx.service.create(admin, input({ issue: { kind: "shared", code: "a!", maxRedemptions: null } }), NOW))).toBe("promo_campaign_invalid");
    expect(await codeOf(ctx.service.create(admin, input({ startsAt: at(-DAY) }), NOW))).toBe("promo_campaign_invalid");
    expect(await codeOf(ctx.service.create(admin, input({ endsAt: at(30 * 60_000), issue: { kind: "shared", code: "SHORT1", maxRedemptions: null } }), NOW))).toBe("promo_campaign_invalid");
  });

  it("пачка: столько разных кодов, сколько заказано; совпавший с занятым — заменяется", async () => {
    // Первые восемь случайных чисел дают код, который уже занят; дальше — новые.
    const ctx = setup({ pick: sequence([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]) });
    const admin = await person(ctx, "400", { role: "admin" });
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "AAAA-AAAA", maxRedemptions: null } }), NOW);
    const batch = await ctx.service.create(admin, input({ title: "Розыгрыш", issue: { kind: "batch", count: 2, prefix: "" } }), NOW);
    expect(batch).toMatchObject({ kind: "batch", maxRedemptions: 2, remaining: 2 });
    const detail = await ctx.service.detail(admin, batch.campaignId, NOW);
    expect(detail.codes.map((code) => code.display)).toEqual(["CCCC-CCCC", "EEEE-EEEE"]);
  });

  it("правка, пауза и удаление — с аудитом; удалить активированный нельзя — только пауза", async () => {
    const ctx = setup();
    const admin = await person(ctx, "500", { role: "admin" });
    const player = await person(ctx, "501");
    const created = await ctx.service.create(admin, input(), NOW);

    const renamed = await ctx.service.update(admin, created.campaignId, updateOf(created, { title: "Стрим 13 октября", maxRedemptions: 100 }), at(HOUR));
    expect(renamed).toMatchObject({ title: "Стрим 13 октября", maxRedemptions: 100, remaining: 100 });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "promo.update", before: { title: "Стрим 12 октября" }, after: { title: "Стрим 13 октября" } });

    expect((await ctx.service.pause(admin, created.campaignId, true, at(HOUR))).state).toBe("paused");
    expect(await codeOf(ctx.service.redeem(player, "рубеж2026", at(2 * HOUR)))).toBe("promo_code_paused");
    expect((await ctx.service.pause(admin, created.campaignId, false, at(3 * HOUR))).state).toBe("active");
    expect(ctx.roles.entries.slice(-2).map((entry) => entry.action)).toEqual(["promo.pause", "promo.resume"]);

    await ctx.service.redeem(player, "рубеж2026", at(4 * HOUR));
    expect(await codeOf(ctx.service.remove(admin, created.campaignId))).toBe("promo_campaign_used");
    expect(await codeOf(ctx.service.update(admin, created.campaignId, updateOf(renamed, { reward: { ...renamed.reward, coins: 9_000 } }), at(5 * HOUR)))).toBe("promo_campaign_invalid");

    const unused = await ctx.service.create(admin, input({ issue: { kind: "shared", code: "UNUSED1", maxRedemptions: null } }), NOW);
    await ctx.service.remove(admin, unused.campaignId);
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "promo.remove", target: unused.campaignId });
    expect(await codeOf(ctx.service.remove(admin, unused.campaignId))).toBe("promo_campaign_not_found");
    // Освободившийся код можно занять снова: его никто не активировал.
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "UNUSED1", maxRedemptions: null } }), NOW);
  });

  it("карточка: активации по игровым суткам, список новыми первыми, с состоянием и остатком", async () => {
    const ctx = setup();
    const admin = await person(ctx, "600", { role: "admin" });
    const first = await ctx.service.create(admin, input({ issue: { kind: "shared", code: "FIRST1", maxRedemptions: 5 } }), NOW);
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "SECOND", maxRedemptions: null }, startsAt: at(DAY), endsAt: null }), at(1_000));
    for (const [id, offset] of [["601", HOUR], ["602", 2 * HOUR], ["603", DAY]] as const) await ctx.service.redeem(await person(ctx, id), "first1", at(offset));

    const catalog = await ctx.service.catalog(admin, at(DAY + HOUR));
    expect(catalog.campaigns.map((campaign) => [campaign.codeSample, campaign.state, campaign.remaining])).toEqual([
      ["SECOND", "active", null],
      ["FIRST1", "active", 2],
    ]);
    expect(catalog.limits).toEqual(PROMO_CODE_LIMITS);
    const detail = await ctx.service.detail(admin, first.campaignId, at(DAY + HOUR));
    expect(detail.daily).toEqual([
      { day: "2026-10-02", count: 2 },
      { day: "2026-10-03", count: 1 },
    ]);
    expect(await codeOf(ctx.service.detail(admin, randomUUID(), NOW))).toBe("promo_campaign_not_found");
  });
});

describe("ввод кода игроком", () => {
  it("общий код: награда ключами по кампании и игроку, текст кампании; повторно — «уже получили»", async () => {
    const ctx = setup();
    const admin = await person(ctx, "700", { role: "admin" });
    const player = await person(ctx, "701");
    const campaign = await ctx.service.create(admin, input(), NOW);

    const result = await ctx.service.redeem(player, "  рубеж-2026 ", at(HOUR));
    expect(result).toEqual({
      credited: { coins: 1_000, gems: 20, shard_common: 0, shard_uncommon: 0 },
      capped: false,
      message: "Спасибо, что смотрели стрим!",
      campaignId: campaign.campaignId,
      kind: "shared",
    });
    expect(ctx.wallet.grants.map((grant) => [grant.resource, grant.amount, grant.reason, grant.idempotencyKey])).toEqual([
      ["coins", 1_000, "promo_reward", `promo:${campaign.campaignId}:${player.accountId}:coins`],
      ["gems", 20, "promo_reward", `promo:${campaign.campaignId}:${player.accountId}:gems`],
    ]);
    expect(await codeOf(ctx.service.redeem(player, "РУБЕЖ2026", at(2 * HOUR)))).toBe("promo_code_already");
    expect(ctx.wallet.grants).toHaveLength(2);
    expect(ctx.repository.redemptions[0]).toMatchObject({ rewardedAt: at(HOUR), credited: { coins: 1_000, gems: 20 } });
  });

  it("нет кода, мусор и слишком длинный — одинаково «такого кода нет»", async () => {
    const ctx = setup();
    const player = await person(ctx, "800");
    for (const raw of ["NOPE2026", "", "ab", "x".repeat(40), "'; DROP TABLE promo_code; --"]) expect(await codeOf(ctx.service.redeem(player, raw, NOW)), raw).toBe("promo_code_not_found");
  });

  it("лимит общего кода: последний активирует, следующему — «исчерпан»", async () => {
    const ctx = setup();
    const admin = await person(ctx, "900", { role: "admin" });
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "LIMIT2", maxRedemptions: 2 } }), NOW);
    await ctx.service.redeem(await person(ctx, "901"), "limit2", at(1));
    await ctx.service.redeem(await person(ctx, "902"), "limit2", at(2));
    expect(await codeOf(ctx.service.redeem(await person(ctx, "903"), "limit2", at(3)))).toBe("promo_code_exhausted");
  });

  it("пачка: код — одному игроку, второй код той же раздачи тому же игроку не даст ничего", async () => {
    const ctx = setup();
    const admin = await person(ctx, "1000", { role: "admin" });
    const batch = await ctx.service.create(admin, input({ title: "Розыгрыш", issue: { kind: "batch", count: 3, prefix: "win" } }), NOW);
    const [first, second] = (await ctx.service.detail(admin, batch.campaignId, NOW)).codes;
    const alice = await person(ctx, "1001");
    const bob = await person(ctx, "1002");

    expect((await ctx.service.redeem(alice, (first?.display ?? "").toLowerCase(), at(1))).kind).toBe("batch");
    expect(await codeOf(ctx.service.redeem(bob, first?.display ?? "", at(2)))).toBe("promo_code_used");
    expect(await codeOf(ctx.service.redeem(alice, second?.display ?? "", at(3)))).toBe("promo_code_already");
    await ctx.service.redeem(bob, second?.display ?? "", at(4));
    const detail = await ctx.service.detail(admin, batch.campaignId, at(5));
    expect(detail.campaign).toMatchObject({ redeemed: 2, remaining: 1 });
    expect(detail.codes.filter((code) => code.redeemedAt !== null)).toHaveLength(2);
  });

  it("срок, площадка и «только новичкам» — своими кодами отказа", async () => {
    const ctx = setup();
    const admin = await person(ctx, "1100", { role: "admin" });
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "LATER1", maxRedemptions: null }, startsAt: at(DAY), endsAt: at(2 * DAY) }), NOW);
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "VKONLY", maxRedemptions: null }, platforms: ["vk"] }), NOW);
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "NEWBIE", maxRedemptions: null }, newPlayersDays: 7 }), NOW);
    const veteran = await person(ctx, "1101", { createdAt: at(-60 * DAY) });
    const newbie = await person(ctx, "1102", { createdAt: at(-2 * DAY) });

    expect(await codeOf(ctx.service.redeem(veteran, "later1", NOW))).toBe("promo_code_scheduled");
    expect(await codeOf(ctx.service.redeem(veteran, "later1", at(3 * DAY)))).toBe("promo_code_expired");
    expect(await codeOf(ctx.service.redeem(veteran, "vkonly", NOW))).toBe("promo_code_platform");
    expect((await ctx.service.redeem(await person(ctx, "1103", { platform: "vk" }), "vkonly", NOW)).kind).toBe("shared");
    expect(await codeOf(ctx.service.redeem(veteran, "newbie", NOW))).toBe("promo_code_new_players");
    expect((await ctx.service.redeem(newbie, "newbie", NOW)).kind).toBe("shared");
  });

  it("заблокированному — нельзя; отказ не занимает активацию", async () => {
    const ctx = setup();
    const admin = await person(ctx, "1200", { role: "admin" });
    await ctx.service.create(admin, input({ issue: { kind: "shared", code: "ONCE01", maxRedemptions: 1 } }), NOW);
    const banned = await person(ctx, "1201");
    ctx.accounts.ban(banned.accountId, "фрод");
    expect(await codeOf(ctx.service.redeem(banned, "once01", NOW))).toBe("forbidden");
    expect((await ctx.service.redeem(await person(ctx, "1202"), "once01", NOW)).kind).toBe("shared");
  });

  it("упала запись награды — повторный ввод доначисляет теми же ключами, а не говорит «уже получили»", async () => {
    const ctx = setup();
    const admin = await person(ctx, "1300", { role: "admin" });
    const player = await person(ctx, "1301");
    await ctx.service.create(admin, input(), NOW);
    ctx.repository.failMarkRewarded = true;
    await expect(ctx.service.redeem(player, "рубеж2026", NOW)).rejects.toThrow("база недоступна");

    const retry = await ctx.service.redeem(player, "рубеж2026", at(1_000));
    expect(retry.credited).toEqual({ coins: 1_000, gems: 20, shard_common: 0, shard_uncommon: 0 });
    // Ключи те же — кошелёк не начислил второй раз.
    expect(ctx.wallet.grants).toHaveLength(2);
    expect(ctx.repository.redemptions[0]?.rewardedAt).toEqual(at(1_000));
    expect(await codeOf(ctx.service.redeem(player, "рубеж2026", at(2_000)))).toBe("promo_code_already");
  });

  it("суточный потолок кошелька срезал награду — игрок узнаёт об этом из ответа", async () => {
    const ctx = setup();
    const admin = await person(ctx, "1400", { role: "admin" });
    await ctx.service.create(admin, input(), NOW);
    ctx.wallet.cap = { coins: 300 };
    const result = await ctx.service.redeem(await person(ctx, "1401"), "рубеж2026", NOW);
    expect(result).toMatchObject({ capped: true, credited: { coins: 300, gems: 20 } });
  });

  it("потолок кошелька за сутки — два самых щедрых кода", () => {
    const cap = WALLET_DAILY_CAPS.promo_reward;
    for (const [resource, max] of Object.entries(PROMO_CODE_LIMITS.reward)) expect(cap[resource as keyof typeof cap], resource).toBe(2 * max);
  });
});

describe("промокоды по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("игрок: без токена — 401, кривое тело — «нет кода», удачный ввод — 200, одиннадцатая попытка за десять минут — 429", async () => {
    const ctx = setup();
    const admin = await person(ctx, "1500", { role: "admin" });
    const player = await person(ctx, "1501");
    await ctx.service.create(admin, input({ startsAt: new Date(), endsAt: null }), new Date());
    @Module({
      controllers: [PromoCodesController],
      providers: [
        { provide: APP_CONFIG, useValue: ctx.config },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: PromoCodesService, useValue: ctx.service },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken(player, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const url = "/api/v1/promo-codes/redeem";

    expect((await app.inject({ method: "POST", url, payload: { code: "RUBEZH2026" } })).statusCode).toBe(401);
    const garbage = await app.inject({ method: "POST", url, headers, payload: { code: 42 } });
    expect(garbage.statusCode).toBe(404);
    expect(garbage.json<{ error: { code: string } }>().error.code).toBe("promo_code_not_found");

    const ok = await app.inject({ method: "POST", url, headers, payload: { code: "рубеж 2026" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ data: { credited: { coins: number } } }>().data.credited.coins).toBe(1_000);
    const again = await app.inject({ method: "POST", url, headers, payload: { code: "рубеж 2026" } });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("promo_code_already");

    for (let attempt = 4; attempt < 10; attempt++) await app.inject({ method: "POST", url, headers, payload: { code: `GUESS${String(attempt)}` } });
    expect((await app.inject({ method: "POST", url, headers, payload: { code: "GUESS10" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers, payload: { code: "GUESS11" } })).statusCode).toBe(429);
  });

  it("панель: список, проверка кода, заведение, карточка, правка, пауза и удаление; без заголовка панели — 403", async () => {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup({ config: cfg });
    @Module({
      controllers: [AdminSessionController, AdminPromoCodesController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: PromoCodesService, useValue: ctx.service },
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
    const base = "/api/v1/admin/promo-codes";
    const now = Date.now();
    const payload = {
      title: "Стрим",
      note: null,
      message: null,
      reward: { coins: 500, gems: 0, shard_common: 10, shard_uncommon: 0 },
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(now + 3 * DAY).toISOString(),
      newPlayersDays: null,
      platforms: [],
      issue: { kind: "shared", code: "STREAM1", maxRedemptions: 100 },
    };

    const list = await app.inject({ method: "GET", url: base, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: { campaigns: unknown[]; platforms: string[] } }>().data).toMatchObject({ campaigns: [], platforms: ["telegram", "max", "vk", "web"] });

    expect((await app.inject({ method: "POST", url: base, headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: base, headers, payload: { ...payload, reward: { coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 } } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: base, headers, payload });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json<{ data: { campaignId: string } }>().data.campaignId;
    expect((await app.inject({ method: "POST", url: base, headers, payload })).statusCode).toBe(409);

    const check = await app.inject({ method: "GET", url: `${base}/check?code=stream-1`, headers });
    expect(check.json<{ data: { taken: { title: string } | null } }>().data.taken?.title).toBe("Стрим");

    const detail = await app.inject({ method: "GET", url: `${base}/${campaignId}`, headers });
    expect(detail.json<{ data: { codes: { display: string }[] } }>().data.codes.map((code) => code.display)).toEqual(["STREAM1"]);
    expect((await app.inject({ method: "GET", url: `${base}/не-uuid`, headers })).statusCode).toBe(400);

    const update = { title: "Стрим 2", note: null, message: null, reward: payload.reward, startsAt: payload.startsAt, endsAt: payload.endsAt, newPlayersDays: null, platforms: [], maxRedemptions: 200 };
    const updated = await app.inject({ method: "POST", url: `${base}/${campaignId}`, headers, payload: update });
    expect(updated.statusCode).toBe(201);
    expect(updated.json<{ data: { title: string; remaining: number } }>().data).toMatchObject({ title: "Стрим 2", remaining: 200 });

    expect((await app.inject({ method: "POST", url: `${base}/${campaignId}/pause`, headers })).json<{ data: { state: string } }>().data.state).toBe("paused");
    expect((await app.inject({ method: "POST", url: `${base}/${campaignId}/resume`, headers })).json<{ data: { state: string } }>().data.state).toBe("active");
    expect((await app.inject({ method: "POST", url: `${base}/${campaignId}/remove`, headers })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base}/${campaignId}/remove`, headers })).statusCode).toBe(404);
  });
});
