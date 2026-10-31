import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminNameRulesStatsController } from "../src/modules/admin/admin-name-rules-stats.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { NameRuleHitsRepository, NameRuleStatsRow } from "../src/modules/name-rules/name-rule-hits.repository.js";
import { NameRulesStatsService, STATS_WINDOWS } from "../src/modules/name-rules/name-rules-stats.service.js";
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

/**
 * Статистика срабатываний правил фильтра имён (tasks/T-0340): окна 7, 30 и 90
 * суток, `lastDay` за всё время хранения, правила без строк — с нулём, право
 * `names.edit`. Хранилище — в памяти, считает так же, как SQL.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-10-30T12:00:00Z");
const RULE_A = "11111111-1111-4111-8111-111111111111";
const RULE_B = "22222222-2222-4222-8222-222222222222";
const RULE_C = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "777000444";

const dayOf = (offset: number): string => new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);

class MemoryHits implements NameRuleHitsRepository {
  /** правила, которые есть в таблице правил */
  readonly rules = new Set<string>([RULE_A, RULE_B, RULE_C]);
  readonly rows: { ruleId: string; day: string; hits: number }[] = [];

  async addHits(): Promise<void> {}
  async prune(): Promise<number> {
    return 0;
  }

  async statsFor(since: string): Promise<{ rules: NameRuleStatsRow[]; trackedSince: string | null }> {
    const rules = [...this.rules].map((ruleId) => {
      const mine = this.rows.filter((row) => row.ruleId === ruleId);
      return {
        ruleId,
        hits: mine.filter((row) => row.day >= since).reduce((sum, row) => sum + row.hits, 0),
        lastDay: mine.length === 0 ? null : mine.map((row) => row.day).sort().at(-1) ?? null,
      };
    });
    const days = this.rows.map((row) => row.day).sort();
    return { rules, trackedSince: days[0] ?? null };
  }
}

function build() {
  const cfg = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const hits = new MemoryHits();
  const rolesService = new RolesService(cfg, roles, accounts);
  const service = new NameRulesStatsService(hits, rolesService);
  return { cfg, accounts, roles, hits, service };
}

async function person(accounts: MemoryAccountRepository, roles: MemoryRolesRepository, id: string, role: "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  await roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof DomainError ? error.code : "unknown";
  }
}

describe("статистика срабатываний правил", () => {
  it("окна — 7, 30 и 90 суток", () => {
    expect([...STATS_WINDOWS]).toEqual([7, 30, 90]);
  });

  it("окно 7: строки за 3 суток назад в счёт идут, за 40 — нет; lastDay — максимум за всё время; правило без строк — 0 и null", async () => {
    const { accounts, roles, hits, service } = build();
    const moderator = await person(accounts, roles, "950", "moderator");
    hits.rows.push({ ruleId: RULE_A, day: dayOf(-3), hits: 4 }, { ruleId: RULE_A, day: dayOf(0), hits: 2 }, { ruleId: RULE_A, day: dayOf(-40), hits: 100 });
    hits.rows.push({ ruleId: RULE_B, day: dayOf(-40), hits: 7 });

    const view = await service.stats(moderator, 7, NOW);

    expect(view.days).toBe(7);
    expect(view.since).toBe(dayOf(-6));
    expect(view.rules.find((rule) => rule.ruleId === RULE_A)).toEqual({ ruleId: RULE_A, hits: 6, lastDay: dayOf(0) });
    // За 40 суток назад — вне окна, но «последний раз» живёт за всё время хранения.
    expect(view.rules.find((rule) => rule.ruleId === RULE_B)).toEqual({ ruleId: RULE_B, hits: 0, lastDay: dayOf(-40) });
    expect(view.rules.find((rule) => rule.ruleId === RULE_C)).toEqual({ ruleId: RULE_C, hits: 0, lastDay: null });
    expect(view.rules).toHaveLength(3);
    expect(view.totalHits).toBe(6);
  });

  it("окно 30 и 90 берут своё: 40 суток назад — вне 30, внутри 90", async () => {
    const { accounts, roles, hits, service } = build();
    const moderator = await person(accounts, roles, "951", "moderator");
    hits.rows.push({ ruleId: RULE_A, day: dayOf(-40), hits: 5 }, { ruleId: RULE_A, day: dayOf(-10), hits: 1 });

    expect((await service.stats(moderator, 30, NOW)).rules.find((rule) => rule.ruleId === RULE_A)?.hits).toBe(1);
    expect((await service.stats(moderator, 90, NOW)).rules.find((rule) => rule.ruleId === RULE_A)?.hits).toBe(6);
    expect((await service.stats(moderator, 90, NOW)).totalHits).toBe(6);
  });

  it("trackedSince — первые сутки, за которые есть счётчики; без данных — null", async () => {
    const { accounts, roles, hits, service } = build();
    const moderator = await person(accounts, roles, "952", "moderator");
    expect((await service.stats(moderator, 30, NOW)).trackedSince).toBeNull();

    hits.rows.push({ ruleId: RULE_B, day: dayOf(-12), hits: 1 }, { ruleId: RULE_A, day: dayOf(-2), hits: 1 });
    expect((await service.stats(moderator, 30, NOW)).trackedSince).toBe(dayOf(-12));
  });

  it("правило, удалённое из таблицы правил, в ответ не попадает вместе с его строками", async () => {
    const { accounts, roles, hits, service } = build();
    const moderator = await person(accounts, roles, "953", "moderator");
    hits.rows.push({ ruleId: RULE_C, day: dayOf(-1), hits: 9 });
    hits.rules.delete(RULE_C);

    const view = await service.stats(moderator, 7, NOW);

    expect(view.rules.map((rule) => rule.ruleId).sort()).toEqual([RULE_A, RULE_B]);
    expect(view.totalHits).toBe(0);
  });

  it("нужен names.edit: геймдизайнеру — отказ; окно не из списка — ошибка границы", async () => {
    const { accounts, roles, service } = build();
    const designer = await person(accounts, roles, "954", "game_designer");
    const moderator = await person(accounts, roles, "955", "moderator");

    expect(await codeOf(service.stats(designer, 30, NOW))).toBe("forbidden");
    for (const days of [3, 0, 365, 7.5]) expect(await codeOf(service.stats(moderator, days, NOW)), String(days)).toBe("validation_failed");
    expect(await codeOf(service.stats(moderator, 30, NOW))).toBe("ok");
  });

  it("ответ нейтрален: ни ников, ни id игроков — только id правила, число и сутки", async () => {
    const { accounts, roles, hits, service } = build();
    const moderator = await person(accounts, roles, "956", "moderator");
    hits.rows.push({ ruleId: RULE_A, day: dayOf(0), hits: 3 });

    const view = await service.stats(moderator, 7, NOW);

    expect(Object.keys(view).sort()).toEqual(["days", "rules", "since", "totalHits", "trackedSince"]);
    for (const rule of view.rules) expect(Object.keys(rule).sort()).toEqual(["hits", "lastDay", "ruleId"]);
  });
});

describe("ручка статистики по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без сессии — 401, геймдизайнеру — 403, модератору — 200; без параметра окно 30; days=3 и days=abc — 400", async () => {
    const { cfg, accounts, roles, hits, service } = build();
    const store = new MemoryAdminSessionStore();
    hits.rows.push({ ruleId: RULE_A, day: dayOf(-1), hits: 2 });
    const reachable = new Date();
    hits.rows.push({ ruleId: RULE_B, day: reachable.toISOString().slice(0, 10), hits: 1 });

    @Module({
      controllers: [AdminSessionController, AdminNameRulesStatsController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: NameRulesStatsService, useValue: service },
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
    const url = "/api/v1/admin/name-rules/stats";

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);

    const designer = await person(accounts, roles, "960", "game_designer");
    await store.put(hashSessionToken("designer"), { ...designer, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    expect((await app.inject({ method: "GET", url, headers: { cookie: `${ADMIN_SESSION_COOKIE}=designer` } })).statusCode).toBe(403);

    const moderator = await person(accounts, roles, "961", "moderator");
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=mod` };

    const byDefault = await app.inject({ method: "GET", url, headers });
    expect(byDefault.statusCode).toBe(200);
    expect(byDefault.json<{ data: { days: number; rules: unknown[] } }>().data).toMatchObject({ days: 30 });
    expect(byDefault.json<{ data: { rules: unknown[] } }>().data.rules).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: `${url}?days=7`, headers })).json<{ data: { days: number } }>().data.days).toBe(7);
    expect((await app.inject({ method: "GET", url: `${url}?days=90`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${url}?days=3`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${url}?days=abc`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${url}?days=30&extra=1`, headers })).statusCode).toBe(400);
  });
});
