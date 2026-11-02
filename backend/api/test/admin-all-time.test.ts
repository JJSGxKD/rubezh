import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { windowOf, type ActivityWindow } from "../src/modules/admin-notify/activity-snapshot.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminAllTimeController } from "../src/modules/admin/admin-all-time.controller.js";
import {
  ALL_TIME_REPOSITORY,
  ALL_TIME_STORE,
  type AccountsRow,
  type AllTimeRepository,
  type AllTimeStore,
  type RecordRow,
  type RevenueRow,
  type RunsRow,
} from "../src/modules/admin/admin-all-time.repository.js";
import { ALL_TIME_KEY, ALL_TIME_LOCK_KEY, ALL_TIME_LOCK_TTL_SEC, ALL_TIME_TTL_SEC, AdminAllTimeService, type AllTime } from "../src/modules/admin/admin-all-time.service.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import type { Account } from "../src/modules/auth/account.repository.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { REDIS } from "../src/infra/redis.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Панель «Чего достигли» (tasks/T-0203), серверная часть на памяти: права,
 * сборка цифр и рекордов, кеш на пять минут с замком, сбой чтения без
 * частичных данных. Сами запросы к базе и Redis — в `admin-all-time.integration.test.ts`.
 */

/** 1 октября 2026, 21:30 по Москве */
const NOW = new Date("2026-10-01T18:30:00.000Z");
const TODAY = "2026-10-01";
const DAY_MS = 86_400_000;

class FakeRepository implements AllTimeRepository {
  readonly calls = { accounts: 0, runs: 0, revenue: 0, records: 0, activeIn: 0 };
  readonly windows: ActivityWindow[] = [];
  failing: keyof FakeRepository["calls"] | null = null;
  delayMs = 0;
  accountRows: AccountsRow[] = [
    { platform: "vk", total: 340, banned: 0, reachable: 100 },
    { platform: "telegram", total: 1200, banned: 3, reachable: 800 },
    { platform: "web", total: 0, banned: 0, reachable: 0 },
    { platform: "max", total: 60, banned: 1, reachable: 0 },
  ];
  runsRow: RunsRow = { runs: 5000, players: 900 };
  revenueRow: RevenueRow = { paid: 500, refunded: 120, purchases: 12 };
  recordRows: { dau: RecordRow | null; wau: RecordRow | null; mau: RecordRow | null } = {
    dau: { day: "2026-09-20", value: 100 },
    wau: { day: "2026-09-21", value: 300 },
    mau: { day: "2026-09-22", value: 700 },
  };
  /** живые цифры сегодняшних суток: окно в 1, 7 и 30 суток */
  live = { dau: 90, wau: 250, mau: 650 };

  private async step<T>(name: keyof FakeRepository["calls"], value: T): Promise<T> {
    this.calls[name]++;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failing === name) throw new Error(`база не ответила: ${name}`);
    return value;
  }

  accounts = () => this.step("accounts", this.accountRows);
  runs = () => this.step("runs", this.runsRow);
  revenue = () => this.step("revenue", this.revenueRow);
  records = () => this.step("records", { ...this.recordRows });
  async activeIn(window: ActivityWindow): Promise<number> {
    this.windows.push(window);
    const length = Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS);
    return await this.step("activeIn", length === 1 ? this.live.dau : length === 7 ? this.live.wau : this.live.mau);
  }
  // Задание снимка этому сервису не нужно.
  lastClosedDay = async (): Promise<string | null> => null;
  firstSessionAt = async (): Promise<Date | null> => null;
  insertDay = async (): Promise<boolean> => true;
}

/** Хранилище кеша в памяти с теми же обещаниями, что у Redis: срок, `SET NX` и снятие замка только своим токеном. */
class MemoryStore implements AllTimeStore {
  readonly values = new Map<string, string>();
  readonly ttl = new Map<string, number>();
  readonly locks = new Map<string, string>();
  readonly lockTtl = new Map<string, number>();
  gets = 0;
  broken = false;

  private check(): void {
    if (this.broken) throw new Error("redis недоступен");
  }
  async get(key: string): Promise<string | null> {
    this.check();
    this.gets++;
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.check();
    this.values.set(key, value);
    this.ttl.set(key, ttlSec);
  }
  async acquire(key: string, token: string, ttlSec: number): Promise<boolean> {
    this.check();
    if (this.locks.has(key)) return false;
    this.locks.set(key, token);
    this.lockTtl.set(key, ttlSec);
    return true;
  }
  async release(key: string, token: string): Promise<void> {
    this.check();
    if (this.locks.get(key) === token) this.locks.delete(key);
  }
  /** Срок вышел. */
  expire(key: string): void {
    this.values.delete(key);
  }
}

async function setup() {
  const repository = new FakeRepository();
  const store = new MemoryStore();
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), rolesRepository, accounts);
  const person = async (id: string, role: Role) => {
    const account: Account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: id, username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  };
  const service = new AdminAllTimeService(repository, store, roles);
  return { service, repository, store, person, owner: await person("1", "owner"), analyst: await person("2", "analyst"), moderator: await person("3", "moderator") };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("права", () => {
  it("без analytics.gameplay.view — отказ, и в базу никто не ходил", async () => {
    const { service, repository, moderator } = await setup();
    await expect(service.allTime(moderator, NOW)).rejects.toMatchObject({ code: "forbidden" });
    expect(Object.values(repository.calls).every((calls) => calls === 0)).toBe(true);
  });

  it("с gameplay, но без revenue — доход null, остальное на месте", async () => {
    const { service, analyst } = await setup();
    const result = await service.allTime(analyst, NOW);
    expect(result.revenue).toBeNull();
    expect(result.accounts.total).toBe(1600);
    expect(result.played).toEqual({ players: 900, runs: 5000 });
    expect(result.records.dau).not.toBeNull();
  });

  it("с обоими правами доход считается: оплачено 500, возвращено 120 — 380 звёзд", async () => {
    const { service, owner } = await setup();
    expect((await service.allTime(owner, NOW)).revenue).toEqual({ stars: 380, paid: 500, refunded: 120, purchases: 12 });
  });

  it("доход режется по праву после кеша: кеш наполнил владелец, аналитик получает null", async () => {
    const { service, repository, owner, analyst } = await setup();
    expect((await service.allTime(owner, NOW)).revenue).not.toBeNull();
    expect((await service.allTime(analyst, NOW)).revenue).toBeNull();
    expect(repository.calls.revenue).toBe(1);
  });

  it("и наоборот: кеш наполнил аналитик, владелец всё равно видит доход — в кеше полный ответ", async () => {
    const { service, store, owner, analyst } = await setup();
    expect((await service.allTime(analyst, NOW)).revenue).toBeNull();
    expect((await service.allTime(owner, NOW)).revenue).toEqual({ stars: 380, paid: 500, refunded: 120, purchases: 12 });
    expect(JSON.parse(store.values.get(ALL_TIME_KEY) ?? "{}").revenue).toEqual({ stars: 380, paid: 500, refunded: 120, purchases: 12 });
  });
});

describe("цифры", () => {
  it("аккаунты и «можно писать» — суммой и по площадкам, крупные первыми", async () => {
    const { service, owner } = await setup();
    const result = await service.allTime(owner, NOW);
    expect(result.accounts).toEqual({
      total: 1600,
      banned: 4,
      byPlatform: [
        { platform: "telegram", total: 1200 },
        { platform: "vk", total: 340 },
        { platform: "max", total: 60 },
        { platform: "web", total: 0 },
      ],
    });
    expect(result.reachable).toEqual({
      total: 900,
      byPlatform: [
        { platform: "telegram", total: 800 },
        { platform: "vk", total: 100 },
        { platform: "max", total: 0 },
        { platform: "web", total: 0 },
      ],
    });
  });

  it("при равенстве площадки идут по имени: порядок не зависит от того, как ответила база", async () => {
    const { service, repository, owner } = await setup();
    repository.accountRows = [
      { platform: "web", total: 5, banned: 0, reachable: 0 },
      { platform: "vk", total: 5, banned: 0, reachable: 0 },
      { platform: "max", total: 5, banned: 0, reachable: 0 },
    ];
    expect((await service.allTime(owner, NOW)).accounts.byPlatform.map((row) => row.platform)).toEqual(["max", "vk", "web"]);
  });

  it("пустая база: нули, пустые списки, рекордов нет", async () => {
    const { service, repository, owner } = await setup();
    repository.accountRows = [];
    repository.runsRow = { runs: 0, players: 0 };
    repository.revenueRow = { paid: 0, refunded: 0, purchases: 0 };
    repository.recordRows = { dau: null, wau: null, mau: null };
    repository.live = { dau: 0, wau: 0, mau: 0 };
    expect(await service.allTime(owner, NOW)).toEqual({
      at: NOW.toISOString(),
      accounts: { total: 0, banned: 0, byPlatform: [] },
      reachable: { total: 0, byPlatform: [] },
      played: { players: 0, runs: 0 },
      revenue: { stars: 0, paid: 0, refunded: 0, purchases: 0 },
      records: { dau: null, wau: null, mau: null },
    });
  });

  it("«посчитано в» — момент пересчёта", async () => {
    const { service, owner } = await setup();
    expect((await service.allTime(owner, NOW)).at).toBe("2026-10-01T18:30:00.000Z");
  });
});

describe("рекорды DAU/WAU/MAU", () => {
  it("живое сегодня выше снимков — рекорд сегодняшний, сутки сегодняшние, «сейчас» — то же число", async () => {
    const { service, repository, owner } = await setup();
    repository.recordRows.dau = { day: "2026-09-20", value: 120 };
    repository.live.dau = 130;
    expect((await service.allTime(owner, NOW)).records.dau).toEqual({ value: 130, day: TODAY, now: 130 });
  });

  it("живое сегодня ниже снимков — рекорд из снимка с его датой, «сейчас» — сегодняшнее", async () => {
    const { service, repository, owner } = await setup();
    repository.recordRows.dau = { day: "2026-09-20", value: 120 };
    repository.live.dau = 90;
    expect((await service.allTime(owner, NOW)).records.dau).toEqual({ value: 120, day: "2026-09-20", now: 90 });
  });

  it("равенство сегодняшнего со снимком — рекорд остаётся за более ранними сутками", async () => {
    const { service, repository, owner } = await setup();
    repository.recordRows.wau = { day: "2026-09-21", value: 250 };
    repository.live.wau = 250;
    expect((await service.allTime(owner, NOW)).records.wau).toEqual({ value: 250, day: "2026-09-21", now: 250 });
  });

  it("снимков нет, сегодня играют — рекорд сегодняшний; снимков нет и сегодня никого — null", async () => {
    const { service, repository, owner } = await setup();
    repository.recordRows = { dau: null, wau: null, mau: null };
    repository.live = { dau: 7, wau: 0, mau: 0 };
    const { records } = await service.allTime(owner, NOW);
    expect(records.dau).toEqual({ value: 7, day: TODAY, now: 7 });
    expect(records.wau).toBeNull();
    expect(records.mau).toBeNull();
  });

  it("снимок с нулём рекордом не считается: рекорд нуля — не рекорд", async () => {
    const { service, repository, owner } = await setup();
    repository.recordRows.mau = { day: "2026-09-22", value: 0 };
    repository.live.mau = 0;
    expect((await service.allTime(owner, NOW)).records.mau).toBeNull();
  });

  it("окна живых цифр — сутки, 7 и 30 суток, заканчивающиеся сегодняшними, по Москве", async () => {
    const { service, repository, owner } = await setup();
    await service.allTime(owner, NOW);
    expect(repository.windows).toEqual(expect.arrayContaining([windowOf(TODAY, 1), windowOf(TODAY, 7), windowOf(TODAY, 30)]));
    expect(repository.windows).toHaveLength(3);
  });

  it("21:30 UTC — уже следующие московские сутки", async () => {
    const { service, repository, owner } = await setup();
    repository.live.dau = 999;
    const result = await service.allTime(owner, new Date("2026-10-01T21:30:00.000Z"));
    expect(result.records.dau?.day).toBe("2026-10-02");
    expect(repository.windows).toContainEqual(windowOf("2026-10-02", 1));
  });
});

describe("кеш", () => {
  it("второй запрос в пределах срока не ходит в репозиторий", async () => {
    const { service, repository, owner } = await setup();
    await service.allTime(owner, NOW);
    const calls = { ...repository.calls };
    await service.allTime(owner, new Date(NOW.getTime() + 60_000));
    expect(repository.calls).toEqual(calls);
  });

  it("кладётся одним ключом на 300 секунд", async () => {
    const { service, store, owner } = await setup();
    await service.allTime(owner, NOW);
    expect([...store.values.keys()]).toEqual([ALL_TIME_KEY]);
    expect(ALL_TIME_KEY).toBe("admin:all-time:v1");
    expect(store.ttl.get(ALL_TIME_KEY)).toBe(300);
    expect(ALL_TIME_TTL_SEC).toBe(300);
  });

  it("срок вышел — считает заново и цифры свежие", async () => {
    const { service, store, repository, owner } = await setup();
    await service.allTime(owner, NOW);
    store.expire(ALL_TIME_KEY);
    repository.runsRow = { runs: 6000, players: 950 };
    expect((await service.allTime(owner, NOW)).played).toEqual({ players: 950, runs: 6000 });
    expect(repository.calls.runs).toBe(2);
  });

  it("«сегодняшнее живое» тоже в кеше: пять минут по подсказке панели, а не запрос на каждое открытие", async () => {
    const { service, repository, owner } = await setup();
    await service.allTime(owner, NOW);
    repository.live.dau = 5000;
    expect((await service.allTime(owner, NOW)).records.dau?.now).toBe(90);
    expect(repository.calls.activeIn).toBe(3);
  });

  it("битый кеш — как пустой: считает заново и перезаписывает", async () => {
    const { service, store, repository, owner } = await setup();
    store.values.set(ALL_TIME_KEY, "{не json");
    expect((await service.allTime(owner, NOW)).accounts.total).toBe(1600);
    expect(repository.calls.accounts).toBe(1);
    expect(JSON.parse(store.values.get(ALL_TIME_KEY) ?? "")).toMatchObject({ accounts: { total: 1600 } });
  });

  it("кеш не той формы (старая версия, чужая запись) — как пустой", async () => {
    const { service, store, repository, owner } = await setup();
    store.values.set(ALL_TIME_KEY, JSON.stringify({ at: "2026-10-01", accounts: 5 }));
    expect((await service.allTime(owner, NOW)).accounts.total).toBe(1600);
    expect(repository.calls.accounts).toBe(1);
  });

  it("Redis недоступен — панель живёт без кеша: считает сама, а не падает", async () => {
    const { service, store, repository, owner } = await setup();
    store.broken = true;
    expect((await service.allTime(owner, NOW)).accounts.total).toBe(1600);
    expect((await service.allTime(owner, NOW)).accounts.total).toBe(1600);
    expect(repository.calls.accounts).toBe(2);
  });

  it("одновременные запросы одной реплики делят один пересчёт", async () => {
    const { service, repository, owner, analyst } = await setup();
    repository.delayMs = 20;
    const [a, b, c] = await Promise.all([service.allTime(owner, NOW), service.allTime(analyst, NOW), service.allTime(owner, NOW)]);
    expect(repository.calls.accounts).toBe(1);
    expect([a.accounts.total, b.accounts.total, c.accounts.total]).toEqual([1600, 1600, 1600]);
    // Права у каждого свои, хотя пересчёт один.
    expect([a.revenue === null, b.revenue === null, c.revenue === null]).toEqual([false, true, false]);
  });
});

describe("замок пересчёта", () => {
  it("на время пересчёта ключ замка занят на 30 секунд, после — свободен", async () => {
    const { service, store, repository, owner } = await setup();
    let during: string | undefined;
    let ttl: number | undefined;
    vi.spyOn(repository, "accounts").mockImplementation(async () => {
      during = store.locks.get(ALL_TIME_LOCK_KEY);
      ttl = store.lockTtl.get(ALL_TIME_LOCK_KEY);
      return repository.accountRows;
    });
    await service.allTime(owner, NOW);
    expect(ALL_TIME_LOCK_KEY).toBe("admin:all-time:v1:lock");
    expect(during).toBeTypeOf("string");
    expect(ttl).toBe(30);
    expect(ALL_TIME_LOCK_TTL_SEC).toBe(30);
    expect(store.locks.size).toBe(0);
  });

  it("замок у соседней реплики: запрос ждёт и берёт её результат, в базу не идёт", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, store, repository, owner } = await setup();
    // Результат «соседа» — другие числа, чтобы было видно, чей ответ взят.
    const neighbour = await setup();
    neighbour.repository.runsRow = { runs: 777, players: 77 };
    await neighbour.service.allTime(neighbour.owner, NOW);
    const neighbourJson = neighbour.store.values.get(ALL_TIME_KEY) ?? "";

    store.locks.set(ALL_TIME_LOCK_KEY, "соседняя-реплика");
    const pending = service.allTime(owner, NOW);
    await vi.advanceTimersByTimeAsync(1_000);
    store.values.set(ALL_TIME_KEY, neighbourJson);
    store.locks.delete(ALL_TIME_LOCK_KEY);
    await vi.advanceTimersByTimeAsync(300);

    expect((await pending).played).toEqual({ players: 77, runs: 777 });
    expect(Object.values(repository.calls).every((calls) => calls === 0)).toBe(true);
  });

  it("опрос — раз в 250 мс", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, store, owner } = await setup();
    store.locks.set(ALL_TIME_LOCK_KEY, "соседняя-реплика");
    const pending = service.allTime(owner, NOW);
    await vi.advanceTimersByTimeAsync(1_000);
    // Первое чтение до замка, дальше — по одному на каждые 250 мс.
    expect(store.gets).toBeGreaterThanOrEqual(4);
    expect(store.gets).toBeLessThanOrEqual(6);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("сосед не успел за 5 секунд — считает сам", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, store, repository, owner } = await setup();
    store.locks.set(ALL_TIME_LOCK_KEY, "соседняя-реплика");
    const pending = service.allTime(owner, NOW);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(repository.calls.accounts).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect((await pending).accounts.total).toBe(1600);
    expect(repository.calls.accounts).toBe(1);
    // Чужой замок мы не трогали.
    expect(store.locks.get(ALL_TIME_LOCK_KEY)).toBe("соседняя-реплика");
  });

  it("пока мы ждали замок, сосед положил результат — повторная проверка после замка не считает второй раз", async () => {
    const { service, store, repository, owner } = await setup();
    const neighbour = await setup();
    await neighbour.service.allTime(neighbour.owner, NOW);
    const neighbourJson = neighbour.store.values.get(ALL_TIME_KEY) ?? "";
    const original = store.acquire.bind(store);
    // Сосед успел между нашим промахом по кешу и взятием замка.
    vi.spyOn(store, "acquire").mockImplementation(async (key, token, ttl) => {
      store.values.set(ALL_TIME_KEY, neighbourJson);
      return await original(key, token, ttl);
    });
    await service.allTime(owner, NOW);
    expect(Object.values(repository.calls).every((calls) => calls === 0)).toBe(true);
    expect(store.locks.size).toBe(0);
  });
});

describe("сбой чтения", () => {
  const reads = ["accounts", "runs", "revenue", "records", "activeIn"] as const;

  it.each(reads)("не ответило чтение «%s» — ошибка целиком, без частичных данных и без кеша; замок снят", async (name) => {
    const { service, store, repository, owner } = await setup();
    repository.failing = name;
    await expect(service.allTime(owner, NOW)).rejects.toThrow("база не ответила");
    expect(store.values.size).toBe(0);
    expect(store.locks.size).toBe(0);
  });

  it("после сбоя следующий запрос считает заново и успевает", async () => {
    const { service, repository, owner } = await setup();
    repository.failing = "revenue";
    await expect(service.allTime(owner, NOW)).rejects.toThrow();
    repository.failing = null;
    expect((await service.allTime(owner, NOW)).revenue?.stars).toBe(380);
  });

  it("зависшее чтение отпускается через 20 секунд, а не держит запрос вечно", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, repository, owner } = await setup();
    vi.spyOn(repository, "runs").mockImplementation(() => new Promise<never>(() => undefined));
    const pending = service.allTime(owner, NOW);
    const outcome = expect(pending).rejects.toThrow("нет ответа за 20000 мс");
    await vi.advanceTimersByTimeAsync(20_001);
    await outcome;
  });
});

describe("по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const sessions = new MemoryAdminSessionStore();
    const repository = new FakeRepository();
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    for (const [id, role, token] of [["1", "owner", "own"], ["2", "analyst", "ana"], ["3", "moderator", "mod"]] as const) {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: id, username: null, photoUrl: null }, Date.now());
      await rolesRepository.grant(account.accountId, role, null);
      await sessions.put(hashSessionToken(token), { accountId: account.accountId, platform: "telegram", platformUserId: id, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    }

    @Module({
      controllers: [AdminAllTimeController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: {} },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: rolesRepository },
        { provide: ADMIN_SESSION_STORE, useValue: sessions },
        { provide: ALL_TIME_REPOSITORY, useValue: repository },
        { provide: ALL_TIME_STORE, useValue: new MemoryStore() },
        AdminAllTimeService,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { server: app, repository };
  }

  const get = (server: NestFastifyApplication, token: string | null) =>
    server.inject({ method: "GET", url: "/api/v1/admin/overview/all-time", ...(token === null ? {} : { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } }) });

  it("без сессии панели — 401, модератору — 403, и в базу не ходили", async () => {
    const { server, repository } = await start();
    expect((await get(server, null)).statusCode).toBe(401);
    expect((await get(server, "mod")).statusCode).toBe(403);
    expect(repository.calls.accounts).toBe(0);
  });

  it("владельцу — ответ в конверте { data } с доходом, аналитику — тот же без дохода", async () => {
    const { server } = await start();
    const owner = await get(server, "own");
    expect(owner.statusCode).toBe(200);
    const body = owner.json() as { data: AllTime };
    expect(body.data.revenue).toEqual({ stars: 380, paid: 500, refunded: 120, purchases: 12 });
    expect(body.data.accounts.total).toBe(1600);

    const analyst = (await get(server, "ana")).json() as { data: AllTime };
    expect(analyst.data.revenue).toBeNull();
    expect(analyst.data.accounts.total).toBe(1600);
  });

  it("сбой чтения — 500 без частичных данных и без подробностей наружу", async () => {
    const { server, repository } = await start();
    repository.failing = "runs";
    const response = await get(server, "own");
    expect(response.statusCode).toBe(500);
    const body = response.json() as { data?: unknown; error: { code: string; message: string } };
    expect(body.data).toBeUndefined();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("база не ответила");
  });
});
