import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminNameRuleCandidatesController } from "../src/modules/admin/admin-name-rule-candidates.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { CANDIDATE_RULES } from "../src/modules/name-rules/name-rule-candidates-rules.js";
import type { CandidateItem, NameRuleCandidatesRepository, StoredCandidate } from "../src/modules/name-rules/name-rule-candidates.repository.js";
import { NameRuleCandidatesAdminService, NameRuleCandidatesService } from "../src/modules/name-rules/name-rule-candidates.service.js";
import type { NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import { NameRuleConflictError, NameRuleNotFoundError } from "../src/modules/name-rules/name-rules-errors.js";
import type { NameRulesRepository, StoredNameRule } from "../src/modules/name-rules/name-rules.repository.js";
import { NameRulesService } from "../src/modules/name-rules/name-rules.service.js";
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
 * Кандидаты в правила фильтра имён (tasks/T-0341, Р168): ночной расчёт на
 * поддельных базе и Redis, замок, ручки панели. Слова нейтральные — списков в
 * репозитории нет. Хранение и забывание — SQL, их проверяет интеграционный тест.
 */

const OWNER_ID = "777000444";
const NOW = new Date("2026-10-30T03:15:00Z");
const DAY = 86_400_000;
const LAST_KEY = "name-rules:candidates:last";
const LOCK_KEY = "name-rules:candidates:lock";

interface FakeAccount {
  accountId: string;
  platformName: string | null;
  displayName: string;
  lastSeenAt: Date;
}

interface AccountQuery {
  where: { lastSeenAt: { gte: Date }; accountId?: { gt: string } };
  orderBy: unknown;
  take: number;
  select: Record<string, boolean>;
}

class FakePrisma {
  accounts: FakeAccount[] = [];
  rules: { ruleId: string; category: string; kind: string; pattern: string; active: boolean }[] = [];
  readonly queries: AccountQuery[] = [];
  /** сколько аккаунтов отдано сервису: `accountId` из них наружу не уходит */
  account = {
    findMany: async (args: AccountQuery) => {
      this.queries.push(args);
      const rows = this.accounts
        .filter((row) => row.lastSeenAt >= args.where.lastSeenAt.gte && (args.where.accountId === undefined || row.accountId > args.where.accountId.gt))
        .sort((a, b) => a.accountId.localeCompare(b.accountId))
        .slice(0, args.take);
      return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => args.select[key] === true)));
    },
  };
  nameRule = {
    findMany: async () => this.rules.filter((rule) => rule.active),
  };
  private counter = 0;

  /** `count` аккаунтов с одним исходным ником */
  add(raw: string | null, count: number, options: { seenDaysAgo?: number; displayName?: string } = {}): void {
    for (let i = 0; i < count; i++) {
      this.counter += 1;
      this.accounts.push({
        accountId: `acc-${String(this.counter).padStart(6, "0")}`,
        platformName: raw,
        displayName: options.displayName ?? raw ?? "Игрок",
        lastSeenAt: new Date(NOW.getTime() - (options.seenDaysAgo ?? 1) * DAY),
      });
    }
  }
}

class FakeRedis {
  readonly store = new Map<string, string>();
  extended = 0;
  async set(key: string, value: string, ...rest: (string | number)[]): Promise<"OK" | null> {
    if (rest.includes("NX") && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async eval(script: string, _keys: number, key: string, ...args: string[]): Promise<number> {
    if (this.store.get(key) !== args[0]) return 0;
    if (script.includes("PEXPIRE")) {
      this.extended += 1;
      return 1;
    }
    this.store.delete(key);
    return 1;
  }
}

class MemoryCandidates implements NameRuleCandidatesRepository {
  readonly rows = new Map<string, StoredCandidate>();
  readonly saved: { items: CandidateItem[]; startedAt: Date }[] = [];
  failSave = false;
  private counter = 0;

  async save(items: readonly CandidateItem[], startedAt: Date): Promise<void> {
    if (this.failSave) throw new Error("база недоступна");
    this.saved.push({ items: items.map((item) => ({ ...item })), startedAt });
    this.rows.clear();
    for (const item of items) this.seed(item);
  }
  seed(patch: CandidateItem & Partial<StoredCandidate>): StoredCandidate {
    this.counter += 1;
    const row: StoredCandidate = {
      candidateId: `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
      firstSeenAt: NOW,
      computedAt: NOW,
      dismissedAt: null,
      dismissedBy: null,
      ...patch,
    };
    this.rows.set(row.candidateId, row);
    return row;
  }
  async list(limit: number): Promise<StoredCandidate[]> {
    return [...this.rows.values()].filter((row) => row.dismissedAt === null).sort((a, b) => b.players - a.players).slice(0, limit);
  }
  async find(candidateId: string): Promise<StoredCandidate | null> {
    return this.rows.get(candidateId) ?? null;
  }
  async remove(candidateId: string): Promise<boolean> {
    return this.rows.delete(candidateId);
  }
  async dismiss(candidateId: string, by: string, at: Date): Promise<{ kind: "word" | "pair" } | null> {
    const row = this.rows.get(candidateId);
    if (row === undefined) return null;
    this.rows.set(candidateId, { ...row, dismissedAt: at, dismissedBy: by });
    return { kind: row.kind };
  }
}

function service(prisma = new FakePrisma(), redis = new FakeRedis(), repository = new MemoryCandidates()) {
  const instance = new NameRuleCandidatesService(prisma as never, redis as unknown as Redis, repository);
  instance.clock = () => NOW;
  return { instance, prisma, redis, repository };
}

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tokensOfSaved = (repository: MemoryCandidates): string[] => (repository.saved.at(-1)?.items ?? []).map((item) => `${item.kind}:${item.token}`).sort();

describe("порог и подсчёт", () => {
  it("слово у 19 разных ников — не кандидат, у 20 — кандидат", async () => {
    const ctx = service();
    ctx.prisma.add("пример-бренд", 20);
    ctx.prisma.add("примерслово", 19);

    await ctx.instance.run();

    expect(tokensOfSaved(ctx.repository)).toEqual(["pair:пример бренд", "word:бренд", "word:пример"]);
    expect(CANDIDATE_RULES.minPlayers).toBe(20);
  });

  it("слово дважды в одном нике считается один раз", async () => {
    const ctx = service();
    ctx.prisma.add("пример пример", 19);
    await ctx.instance.run();
    expect(tokensOfSaved(ctx.repository)).toEqual([]);

    ctx.prisma.add("пример пример", 1);
    await ctx.instance.run();
    expect(ctx.repository.saved.at(-1)?.items).toEqual([{ token: "пример", kind: "word", players: 20 }]);
  });

  it("окно — 30 суток по last_seen_at: условие запроса и результат", async () => {
    const ctx = service();
    ctx.prisma.add("пример-бренд", 20);
    ctx.prisma.add("пример-бренд", 5, { seenDaysAgo: 31 });

    await ctx.instance.run();

    expect(ctx.prisma.queries[0]?.where.lastSeenAt.gte).toEqual(new Date(NOW.getTime() - 30 * DAY));
    expect(ctx.repository.saved.at(-1)?.items.find((item) => item.token === "пример")?.players).toBe(20);
  });

  it("берётся исходник platformName, а без него — очищенный displayName", async () => {
    const ctx = service();
    ctx.prisma.add("Пример-Бренд", 10, { displayName: "Игрок" });
    ctx.prisma.add(null, 10, { displayName: "пример-бренд" });

    await ctx.instance.run();

    expect(ctx.repository.saved.at(-1)?.items.find((item) => item.token === "пример")?.players).toBe(20);
    expect(ctx.repository.saved.at(-1)?.items.some((item) => item.token === "игрок")).toBe(false);
  });

  it("из таблицы читаются только accountId (курсор), platformName и displayName", async () => {
    const ctx = service();
    ctx.prisma.add("пример-бренд", 1);
    await ctx.instance.run();
    expect(ctx.prisma.queries[0]?.select).toEqual({ accountId: true, platformName: true, displayName: true });
  });

  it("пачками: курсор по accountId, все аккаунты прочитаны один раз", async () => {
    const ctx = service();
    ctx.instance.pageSize = 7;
    ctx.prisma.add("пример-бренд", 25);

    const result = await ctx.instance.run();

    expect(result).toMatchObject({ status: "done", scanned: 25, kept: 3, capped: false });
    expect(ctx.prisma.queries.length).toBeGreaterThanOrEqual(4);
    expect(ctx.prisma.queries[1]?.where.accountId?.gt).toBe("acc-000007");
  });

  it("пустая база — штатный исход: ноль кандидатов", async () => {
    const ctx = service();
    expect(await ctx.instance.run()).toEqual({ status: "done", scanned: 0, kept: 0, capped: false });
    expect(ctx.repository.saved.at(-1)?.items).toEqual([]);
  });
});

describe("закрытые слова", () => {
  it("слово под действующим правилом, под исключением и встроенный мат не предлагаются", async () => {
    const ctx = service();
    ctx.prisma.rules = [
      { ruleId: "r1", category: "brand", kind: "word", pattern: "закрытое", active: true },
      { ruleId: "r2", category: "allow", kind: "word", pattern: "разрешённое", active: true },
      { ruleId: "r3", category: "brand", kind: "word", pattern: "выключенное", active: false },
    ];
    for (const raw of ["закрытое", "разрешённое", "хуй", "свободное", "выключенное"]) ctx.prisma.add(raw, 20);

    await ctx.instance.run();

    expect(tokensOfSaved(ctx.repository)).toEqual(["word:выключенное", "word:свободное"]);
  });
});

describe("переполнение и потолок", () => {
  it("сверх mapMax новые слова не заводятся, счёт заведённых идёт; capped = true", async () => {
    const ctx = service();
    ctx.instance.mapMax = 2;
    ctx.prisma.add("альфа бета", 20);
    ctx.prisma.add("гамма", 25);

    const result = await ctx.instance.run();

    expect(result).toMatchObject({ capped: true });
    expect(tokensOfSaved(ctx.repository)).toEqual(["word:альфа", "word:бета"]);
  });

  it("потолок keepMax — остаются самые частые", async () => {
    const ctx = service();
    ctx.instance.keepMax = 2;
    ctx.prisma.add("альфа", 30);
    ctx.prisma.add("бета", 25);
    ctx.prisma.add("гамма", 21);

    await ctx.instance.run();

    expect(ctx.repository.saved.at(-1)?.items).toEqual([
      { token: "альфа", kind: "word", players: 30 },
      { token: "бета", kind: "word", players: 25 },
    ]);
  });
});

describe("приватность", () => {
  it("в save уходят только token, kind и players; в логе слов и ников нет", async () => {
    const ctx = service();
    ctx.prisma.add("Пример-Бренд", 20);

    await ctx.instance.run();

    for (const item of ctx.repository.saved.at(-1)?.items ?? []) expect(Object.keys(item).sort()).toEqual(["kind", "players", "token"]);
    expect(JSON.stringify(ctx.repository.saved)).not.toMatch(/acc-0|Пример-Бренд/);
    const log = logs.join("\n");
    expect(log).toContain("candidates_computed");
    expect(log).not.toMatch(/пример|бренд|acc-0/iu);
  });

  it("итог расчёта — в Redis числами, без слов", async () => {
    const ctx = service();
    ctx.prisma.add("пример-бренд", 20);

    await ctx.instance.run();

    expect(JSON.parse(ctx.redis.store.get(LAST_KEY) ?? "null")).toEqual({ computedAt: NOW.toISOString(), scanned: 20, kept: 3, capped: false });
  });
});

describe("замок", () => {
  it("занятый замок — skipped, чужой токен не снимается, база не тронута", async () => {
    const ctx = service();
    ctx.redis.store.set(LOCK_KEY, "чужой-токен");
    ctx.prisma.add("пример-бренд", 20);

    expect(await ctx.instance.run()).toEqual({ status: "skipped", scanned: 0, kept: 0, capped: false });

    expect(ctx.redis.store.get(LOCK_KEY)).toBe("чужой-токен");
    expect(ctx.repository.saved).toHaveLength(0);
  });

  it("замок снят после успешного прохода и после ошибки записи", async () => {
    const ctx = service();
    ctx.prisma.add("пример-бренд", 20);
    await ctx.instance.run();
    expect(ctx.redis.store.has(LOCK_KEY)).toBe(false);

    ctx.repository.failSave = true;
    await expect(ctx.instance.run()).rejects.toThrow("база недоступна");
    expect(ctx.redis.store.has(LOCK_KEY)).toBe(false);
  });

  it("на каждой пачке замок продлевается", async () => {
    const ctx = service();
    ctx.instance.pageSize = 2;
    ctx.prisma.add("пример-бренд", 5);
    await ctx.instance.run();
    expect(ctx.redis.extended).toBeGreaterThanOrEqual(3);
  });

  it("два одновременных расчёта — считает один", async () => {
    const ctx = service();
    ctx.prisma.add("пример-бренд", 20);
    const results = await Promise.all([ctx.instance.run(), ctx.instance.run()]);
    expect(results.map((result) => result.status).sort()).toEqual(["done", "skipped"]);
  });
});

// --- ручки панели ---------------------------------------------------------

class MemoryNameRules implements NameRulesRepository {
  readonly rows = new Map<string, StoredNameRule>();
  async list(): Promise<StoredNameRule[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async listActive(): Promise<StoredNameRule[]> {
    return (await this.list()).filter((row) => row.active);
  }
  async findByKey(category: string, kind: string, pattern: string): Promise<StoredNameRule | null> {
    return [...this.rows.values()].find((row) => row.category === category && row.kind === kind && row.pattern === pattern) ?? null;
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async countRegex(): Promise<number> {
    return 0;
  }
  async insert(row: StoredNameRule): Promise<void> {
    this.rows.set(row.ruleId, { ...row });
  }
  async update(): Promise<StoredNameRule | null> {
    return null;
  }
  async remove(ruleId: string): Promise<boolean> {
    return this.rows.delete(ruleId);
  }
}

function adminSetup() {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const candidates = new MemoryCandidates();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const rules = new MemoryNameRules();
  const redis = new FakeRedis();
  const cache = { publishChanged: async () => undefined } as unknown as NameRulesCache;
  const rolesService = new RolesService(config, roles, accounts);
  const nameRules = new NameRulesService(rules, cache, rolesService);
  const admin = new NameRuleCandidatesAdminService(candidates, rolesService, nameRules, redis as unknown as Redis);
  return { candidates, accounts, roles, rules, redis, nameRules, admin, config };
}

async function person(ctx: ReturnType<typeof adminSetup>, id: string, role?: "admin" | "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

describe("ручки панели: сервис", () => {
  it("без names.edit — отказ на каждом методе, ничего не тронуто", async () => {
    const ctx = adminSetup();
    const row = ctx.candidates.seed({ token: "пример", kind: "word", players: 25 });
    const designer = await person(ctx, "901", "game_designer");

    await expect(ctx.admin.list(designer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.admin.accept(designer, row.candidateId, { category: "brand", kind: "word" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.admin.dismiss(designer, row.candidateId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(ctx.candidates.rows.size).toBe(1);
    expect(ctx.rules.rows.size).toBe(0);
  });

  it("список: без скрытых, по убыванию игроков, computedAt из Redis; нет расчёта — null", async () => {
    const ctx = adminSetup();
    const admin = await person(ctx, "902", "admin");
    ctx.candidates.seed({ token: "пример", kind: "word", players: 25 });
    ctx.candidates.seed({ token: "пример бренд", kind: "pair", players: 30 });
    ctx.candidates.seed({ token: "скрытое", kind: "word", players: 99, dismissedAt: NOW });

    const empty = await ctx.admin.list(admin);
    expect(empty.computedAt).toBeNull();
    expect(empty).toMatchObject({ minPlayers: 20, windowDays: 30 });

    ctx.redis.store.set(LAST_KEY, JSON.stringify({ computedAt: NOW.toISOString(), scanned: 1, kept: 2, capped: false }));
    const view = await ctx.admin.list(admin);
    expect(view.computedAt).toBe(NOW.toISOString());
    expect(view.items.map((item) => item.token)).toEqual(["пример бренд", "пример"]);
    expect(Object.keys(view.items[0] ?? {}).sort()).toEqual(["candidateId", "firstSeenAt", "kind", "players", "token"]);
  });

  it("accept: создаёт обычное правило с аудитом и удаляет кандидата", async () => {
    const ctx = adminSetup();
    const admin = await person(ctx, "903", "admin");
    const row = ctx.candidates.seed({ token: "пример", kind: "word", players: 25 });
    ctx.roles.entries.length = 0;

    const rule = await ctx.admin.accept(admin, row.candidateId, { category: "brand", kind: "word" });

    expect(rule).toMatchObject({ category: "brand", kind: "word", pattern: "пример", active: true });
    expect(ctx.rules.rows.size).toBe(1);
    expect(ctx.candidates.rows.has(row.candidateId)).toBe(false);
    expect(ctx.roles.entries.map((entry) => entry.action)).toEqual(["names.rule.create"]);
  });

  it("accept в исключения: категория allow", async () => {
    const ctx = adminSetup();
    const admin = await person(ctx, "904", "admin");
    const row = ctx.candidates.seed({ token: "привет", kind: "word", players: 40 });
    expect(await ctx.admin.accept(admin, row.candidateId, { category: "allow", kind: "word" })).toMatchObject({ category: "allow", pattern: "привет" });
  });

  it("accept: неизвестный кандидат — 404; дубль правила — 409 и кандидат цел", async () => {
    const ctx = adminSetup();
    const admin = await person(ctx, "905", "admin");
    const error = await ctx.admin.accept(admin, "00000000-0000-4000-8000-0000000000ff", { category: "brand", kind: "word" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NameRuleNotFoundError);
    expect((error as NameRuleNotFoundError).status).toBe(404);

    const row = ctx.candidates.seed({ token: "пример", kind: "word", players: 25 });
    await ctx.nameRules.create(admin, { category: "brand", kind: "word", pattern: "пример" });
    const conflict = await ctx.admin.accept(admin, row.candidateId, { category: "brand", kind: "word" }).catch((caught: unknown) => caught);
    expect(conflict).toBeInstanceOf(NameRuleConflictError);
    expect((conflict as NameRuleConflictError).status).toBe(409);
    expect(ctx.candidates.rows.has(row.candidateId)).toBe(true);
  });

  it("dismiss: скрывает, пишет аудит без слова", async () => {
    const ctx = adminSetup();
    const admin = await person(ctx, "906", "admin");
    const row = ctx.candidates.seed({ token: "пример-слово", kind: "word", players: 25 });
    ctx.roles.entries.length = 0;

    expect(await ctx.admin.dismiss(admin, row.candidateId, NOW)).toEqual({ dismissed: true });

    expect(ctx.candidates.rows.get(row.candidateId)).toMatchObject({ dismissedAt: NOW, dismissedBy: admin.accountId });
    expect(ctx.roles.entries).toEqual([expect.objectContaining({ action: "names.candidate.dismiss", target: row.candidateId, after: { kind: "word" } })]);
    expect(JSON.stringify(ctx.roles.entries)).not.toContain("пример-слово");
    await expect(ctx.admin.dismiss(admin, "00000000-0000-4000-8000-0000000000ff")).rejects.toBeInstanceOf(NameRuleNotFoundError);
  });
});

describe("ручки панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("круг: чтение, accept с неверной категорией — 400, accept и dismiss, без заголовка панели — 403, без сессии — 401", async () => {
    const ctx = adminSetup();
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const roles = new RolesService(cfg, ctx.roles, ctx.accounts);
    const nameRules = new NameRulesService(ctx.rules, { publishChanged: async () => undefined } as unknown as NameRulesCache, roles);
    const admin = new NameRuleCandidatesAdminService(ctx.candidates, roles, nameRules, ctx.redis as unknown as Redis);

    @Module({
      controllers: [AdminSessionController, AdminNameRuleCandidatesController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: NameRuleCandidatesAdminService, useValue: admin },
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

    const base = "/api/v1/admin/name-rules/candidates";
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const first = ctx.candidates.seed({ token: "пример", kind: "word", players: 25 });
    const second = ctx.candidates.seed({ token: "альфа бета", kind: "pair", players: 22 });

    const listed = await app.inject({ method: "GET", url: base, headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: { items: { token: string }[]; computedAt: string | null } }>().data).toMatchObject({ computedAt: null, items: [{ token: "пример" }, { token: "альфа бета" }] });

    expect((await app.inject({ method: "POST", url: `${base}/${first.candidateId}/accept`, headers: { cookie }, payload: { category: "brand", kind: "word" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/${first.candidateId}/accept`, headers, payload: { category: "spam", kind: "word" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/${first.candidateId}/accept`, headers, payload: { category: "brand", kind: "regex" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/${first.candidateId}/accept`, headers, payload: { category: "brand", kind: "word", extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/не-uuid/accept`, headers, payload: { category: "brand", kind: "word" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/00000000-0000-4000-8000-0000000000ff/accept`, headers, payload: { category: "brand", kind: "word" } })).statusCode).toBe(404);

    const accepted = await app.inject({ method: "POST", url: `${base}/${first.candidateId}/accept`, headers, payload: { category: "brand", kind: "word" } });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json<{ data: { pattern: string; category: string } }>().data).toMatchObject({ pattern: "пример", category: "brand" });
    expect((await app.inject({ method: "POST", url: `${base}/${first.candidateId}/accept`, headers, payload: { category: "brand", kind: "word" } })).statusCode).toBe(404);

    const dismissed = await app.inject({ method: "POST", url: `${base}/${second.candidateId}/dismiss`, headers });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json<{ data: { dismissed: boolean } }>().data).toEqual({ dismissed: true });
    expect((await app.inject({ method: "GET", url: base, headers: { cookie } })).json<{ data: { items: unknown[] } }>().data.items).toEqual([]);
  });
});
