import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { ActivitySnapshotJob } from "../src/modules/admin-notify/activity-snapshot.job.js";
import { windowOf } from "../src/modules/admin-notify/activity-snapshot.js";
import { PrismaAllTimeRepository, RedisAllTimeStore, type AccountsRow, type ActivitySnapshotRepository } from "../src/modules/admin/admin-all-time.repository.js";
import { ALL_TIME_KEY, ALL_TIME_LOCK_KEY, AdminAllTimeService } from "../src/modules/admin/admin-all-time.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Итоги за всё время (tasks/T-0203) на живых Postgres и Redis.
 *
 * Итоги считаются по всей таблице, а в общей тестовой базе параллельно пишут
 * десятки других файлов: абсолютные числа были бы случайными. Поэтому каждый
 * случай идёт в одной транзакции со снимком (REPEATABLE READ): «до» и «после»
 * видят одну и ту же чужую базу плюс записи самого случая, а в конце откат —
 * после теста не остаётся ничего. Сутки сессий и снимков — далёкие, куда не
 * попадают записи соседей. Без базы или Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 14);

const STAMP = randomBytes(4).toString("hex");
const DAY_MS = 86_400_000;
const shift = (day: string, delta: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
/** Московское время суток: сессия в 23:59 и в 00:00 попадает в соседние сутки. */
const at = (day: string, time: string): Date => new Date(`${day}T${time}:00+03:00`);

class Rollback extends Error {}

describe.skipIf(DATABASE_URL === "")("итоги за всё время на живом Postgres", () => {
  let prisma: PrismaClient;
  let counter = 0;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Случай внутри транзакции со снимком; в конце всегда откат. Ошибка проверки пролетает наружу как есть. */
  async function inSnapshot(body: (tx: Prisma.TransactionClient, repository: PrismaAllTimeRepository) => Promise<void>): Promise<void> {
    try {
      await prisma.$transaction(
        async (tx) => {
          await body(tx, new PrismaAllTimeRepository(tx));
          throw new Rollback();
        },
        { isolationLevel: "RepeatableRead", timeout: 60_000, maxWait: 30_000 },
      );
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  async function account(tx: Prisma.TransactionClient, platform: "telegram" | "max" | "vk" | "web", extra: { bannedAt?: Date } = {}): Promise<string> {
    const accountId = randomUUID();
    await tx.account.create({ data: { accountId, platform, platformUserId: `ati-${STAMP}-${String(counter++)}`, displayName: "Итоги", ...extra } });
    return accountId;
  }

  async function messaging(tx: Prisma.TransactionClient, accountId: string, canMessage: boolean): Promise<void> {
    await tx.accountMessaging.create({ data: { accountId, canMessage, reason: canMessage ? "entered" : "blocked", changedAt: new Date() } });
  }

  async function session(tx: Prisma.TransactionClient, accountId: string, startedAt: Date): Promise<void> {
    await tx.accountSession.create({ data: { sessionId: randomUUID(), accountId, platform: "telegram", place: "miniapp", startKind: "organic", deviceClass: "mobile", os: "android", startedAt } });
  }

  async function run(tx: Prisma.TransactionClient, accountId: string, patch: { status?: "finished" | "started"; cheats?: boolean } = {}): Promise<string> {
    const runId = `ati-${STAMP}-${String(counter++)}`;
    const finished = (patch.status ?? "finished") === "finished";
    const when = new Date();
    await tx.run.create({
      data: {
        runId,
        accountId,
        status: patch.status ?? "finished",
        difficulty: "hard",
        startingWeaponId: "spark",
        contentHash: "h",
        startedAt: when,
        finishedAt: finished ? when : null,
        survivalSec: finished ? 60 : null,
        cheats: patch.cheats ?? false,
        outcome: finished ? "died" : null,
      },
    });
    return runId;
  }

  const rowOf = (rows: readonly AccountsRow[], platform: string): AccountsRow => rows.find((row) => row.platform === platform) ?? { platform: platform as AccountsRow["platform"], total: 0, banned: 0, reachable: 0 };

  it("аккаунты: «всего», «заблокировано» и «можно писать» по площадкам; нет строки в account_messaging — писать нельзя", async () => {
    await inSnapshot(async (tx, repository) => {
      const before = await repository.accounts();
      const writable = await account(tx, "telegram");
      await messaging(tx, writable, true);
      const closed = await account(tx, "telegram");
      await messaging(tx, closed, false);
      await account(tx, "vk");
      // Заблокированный банном не вычитается ни из «всего», ни из «можно писать»: рассылка отсеет его сама.
      const banned = await account(tx, "web", { bannedAt: new Date() });
      await messaging(tx, banned, true);

      const after = await repository.accounts();
      const delta = (platform: string) => {
        const [was, now] = [rowOf(before, platform), rowOf(after, platform)];
        return { total: now.total - was.total, banned: now.banned - was.banned, reachable: now.reachable - was.reachable };
      };
      expect(delta("telegram")).toEqual({ total: 2, banned: 0, reachable: 1 });
      expect(delta("vk")).toEqual({ total: 1, banned: 0, reachable: 0 });
      expect(delta("web")).toEqual({ total: 1, banned: 1, reachable: 1 });
      expect(delta("max")).toEqual({ total: 0, banned: 0, reachable: 0 });
    });
  });

  it("доход: живые оплаченные и возвращённые; тестовые и неоплаченные не входят", async () => {
    await inSnapshot(async (tx, repository) => {
      const before = await repository.revenue();
      const buyer = await account(tx, "telegram");
      const runId = await run(tx, buyer);
      const base = { accountId: buyer, product: "continue_run" as const, runId, elapsedSec: 60, invoicedAt: new Date() };
      await tx.purchase.createMany({
        data: [
          { ...base, purchaseId: randomUUID(), continueNo: 1, priceStars: 50, chargedStars: 50, mode: "live", status: "paid", paidAt: new Date() },
          // Возвращённая оплата: и оплачена, и возвращена.
          { ...base, purchaseId: randomUUID(), continueNo: 2, priceStars: 30, chargedStars: 30, mode: "live", status: "refunded", paidAt: new Date(), refundedAt: new Date() },
          // Тестовая оплата в выручку не идёт.
          { ...base, purchaseId: randomUUID(), continueNo: 3, priceStars: 30, chargedStars: 1, mode: "test", status: "paid", paidAt: new Date() },
          // Счёт выставлен, оплаты нет.
          { ...base, purchaseId: randomUUID(), continueNo: 4, priceStars: 40, chargedStars: 40, mode: "live", status: "pending" },
        ],
      });
      const after = await repository.revenue();
      expect({ paid: after.paid - before.paid, refunded: after.refunded - before.refunded, purchases: after.purchases - before.purchases }).toEqual({ paid: 80, refunded: 30, purchases: 2 });
    });
  });

  it("забеги и игроки: законченные без читов; два забега одного аккаунта — один игрок, два забега", async () => {
    await inSnapshot(async (tx, repository) => {
      const before = await repository.runs();
      const twice = await account(tx, "telegram");
      await run(tx, twice);
      await run(tx, twice);
      const cheater = await account(tx, "telegram");
      await run(tx, cheater, { cheats: true });
      const unfinished = await account(tx, "telegram");
      await run(tx, unfinished, { status: "started" });
      const after = await repository.runs();
      expect({ runs: after.runs - before.runs, players: after.players - before.players }).toEqual({ runs: 2, players: 1 });
    });
  });

  it("сессии у московской полуночи попадают в соседние сутки; WAU — семь суток включительно, MAU — тридцать", async () => {
    const day = "2092-06-15";
    await inSnapshot(async (tx, repository) => {
      const ids = new Map<string, string>();
      for (const name of ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]) ids.set(name, await account(tx, "telegram"));
      const id = (name: string): string => ids.get(name) ?? "";
      await session(tx, id("p1"), at(shift(day, -1), "23:59")); // последняя минута предыдущих суток
      await session(tx, id("p2"), at(day, "00:00")); // первая минута этих суток
      await session(tx, id("p2"), at(day, "13:00")); // тот же человек — считается один раз
      await session(tx, id("p3"), at(shift(day, -6), "00:00")); // первая минута окна WAU
      await session(tx, id("p4"), at(shift(day, -7), "23:59")); // последняя минута до окна WAU, но в MAU
      await session(tx, id("p5"), at(shift(day, -29), "00:00")); // первая минута окна MAU
      await session(tx, id("p6"), at(shift(day, -30), "23:59")); // последняя минута до окна MAU
      await session(tx, id("p7"), at(shift(day, 1), "00:00")); // первая минута следующих суток

      expect(await repository.activeIn(windowOf(day, 1))).toBe(1);
      expect(await repository.activeIn(windowOf(day, 7))).toBe(3);
      expect(await repository.activeIn(windowOf(day, 30))).toBe(5);
      // Следующие сутки видят только запуск после полуночи.
      expect(await repository.activeIn(windowOf(shift(day, 1), 1))).toBe(1);
    });
  });

  it("рекорды: максимум по снимкам, при равенстве — более ранние сутки; вставка суток идемпотентна", async () => {
    await inSnapshot(async (_tx, repository) => {
      const early = "2092-07-01";
      const late = "2092-07-02";
      expect(await repository.insertDay(late, 9_000_001, 8_000_003, 7_000_002)).toBe(true);
      expect(await repository.insertDay(early, 9_000_001, 8_000_002, 7_000_003)).toBe(true);
      // Повтор тех же суток с другими числами — отказ без ошибки, прежняя строка цела.
      expect(await repository.insertDay(early, 1, 1, 1)).toBe(false);

      const records = await repository.records();
      expect(records.dau).toEqual({ day: early, value: 9_000_001 });
      expect(records.wau).toEqual({ day: late, value: 8_000_003 });
      expect(records.mau).toEqual({ day: early, value: 7_000_003 });
      expect(await repository.lastClosedDay()).toBeTypeOf("string");
    });
  });

  it("первая сессия — минимум по всей таблице, не позже самой ранней добавленной", async () => {
    await inSnapshot(async (tx, repository) => {
      const early = at("2091-02-03", "10:00");
      await session(tx, await account(tx, "telegram"), early);
      const first = await repository.firstSessionAt();
      expect(first).not.toBeNull();
      expect((first as Date).getTime()).toBeLessThanOrEqual(early.getTime());
    });
  });

  it("бэкфилл: пустая таблица и сессии за три дня дают строку на каждые сутки, в том числе пустые; второй проход ничего не меняет", async () => {
    const first = "2093-03-10";
    const [second, third] = [shift(first, 1), shift(first, 2)];
    const start = shift(first, -2);
    await inSnapshot(async (tx, repository) => {
      const p1 = await account(tx, "telegram");
      const p2 = await account(tx, "telegram");
      await session(tx, p1, at(first, "10:00"));
      await session(tx, p2, at(first, "11:00"));
      await session(tx, p1, at(third, "10:00"));

      // Общая таблица может уже хранить настоящие сутки: из неё видны только мои далёкие, а начало — моё.
      const scoped: ActivitySnapshotRepository = {
        lastClosedDay: async () => {
          const real = await repository.lastClosedDay();
          return real !== null && real >= start ? real : null;
        },
        firstSessionAt: async () => at(start, "00:00"),
        activeIn: (window) => repository.activeIn(window),
        insertDay: (day, dau, wau, mau) => repository.insertDay(day, dau, wau, mau),
      };
      const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
      const job = new ActivitySnapshotJob(config, scoped);
      const now = at(shift(third, 1), "00:20");
      const rows = () =>
        tx.$queryRaw<{ day: string; dau: number; wau: number; mau: number }[]>`SELECT day, dau, wau, mau FROM activity_daily WHERE day >= ${start} AND day <= ${third} ORDER BY day`;

      expect(await job.closeDays(now)).toBe(5);
      const expected = [
        // Сутки до первой сессии: строка есть, цифры нулевые, а не дыра.
        { day: start, dau: 0, wau: 0, mau: 0 },
        { day: shift(start, 1), dau: 0, wau: 0, mau: 0 },
        { day: first, dau: 2, wau: 2, mau: 2 },
        // Пустые сутки посреди истории: за день никого, а недельное и месячное окна помнят вчерашних.
        { day: second, dau: 0, wau: 2, mau: 2 },
        { day: third, dau: 1, wau: 2, mau: 2 },
      ];
      expect(await rows()).toEqual(expected);

      expect(await job.closeDays(now)).toBe(0);
      expect(await rows()).toEqual(expected);
    });
  });
});

describe.skipIf(REDIS_URL === "")("кеш итогов на живом Redis", () => {
  let redis: Redis;
  let store: RedisAllTimeStore;
  const key = (): string => `it:all-time:${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    redis = createRedis(loadAppConfig({ NODE_ENV: "test", REDIS_URL } as NodeJS.ProcessEnv));
    await redis.connect();
    store = new RedisAllTimeStore(redis);
  });
  afterAll(async () => {
    await redis.del(ALL_TIME_KEY, ALL_TIME_LOCK_KEY);
    await closeRedis(redis);
  });
  beforeEach(async () => {
    await redis.del(ALL_TIME_KEY, ALL_TIME_LOCK_KEY);
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("значение читается обратно и живёт ограниченный срок", async () => {
    const name = key();
    expect(await store.get(name)).toBeNull();
    await store.set(name, '{"a":1}', 300);
    expect(await store.get(name)).toBe('{"a":1}');
    const ttl = await redis.ttl(name);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
    await redis.del(name);
  });

  it("замок: первый берёт, второй нет; чужим токеном не снимается; своим — снимается; срок задан", async () => {
    const name = key();
    expect(await store.acquire(name, "первая", 30)).toBe(true);
    expect(await store.acquire(name, "вторая", 30)).toBe(false);
    const ttl = await redis.ttl(name);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);

    await store.release(name, "вторая");
    expect(await redis.get(name)).toBe("первая");
    expect(await store.acquire(name, "вторая", 30)).toBe(false);

    await store.release(name, "первая");
    expect(await redis.get(name)).toBeNull();
    expect(await store.acquire(name, "вторая", 30)).toBe(true);
    await redis.del(name);
  });

  it("две реплики открывают панель одновременно: в базу идёт одна, вторая берёт её результат из кеша", async () => {
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const roles = new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), rolesRepository, accounts);
    const created = await accounts.upsert({ platform: "telegram", platformUserId: "1", displayName: "Вера", username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(created.accountId, "owner", null);
    const owner = { accountId: created.accountId, platform: created.platform, platformUserId: "1" };

    let reads = 0;
    const slow = async <T>(value: T): Promise<T> => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return value;
    };
    const repository = {
      accounts: () => slow([{ platform: "telegram" as const, total: 10, banned: 1, reachable: 4 }]),
      runs: () => slow({ runs: 7, players: 3 }),
      revenue: () => slow({ paid: 20, refunded: 5, purchases: 2 }),
      records: () => slow({ dau: null, wau: null, mau: null }),
      activeIn: () => slow(2),
      lastClosedDay: async () => null,
      firstSessionAt: async () => null,
      insertDay: async () => true,
    };
    // Две реплики — два сервиса, у каждого своё состояние в памяти и общий Redis.
    const first = new AdminAllTimeService(repository, store, roles);
    const second = new AdminAllTimeService(repository, store, roles);
    const [a, b] = await Promise.all([first.allTime(owner), second.allTime(owner)]);

    // Одна проходка: аккаунты, забеги, доход, рекорды и три окна — семь чтений.
    expect(reads).toBe(7);
    expect(a.accounts.total).toBe(10);
    expect(b.accounts.total).toBe(10);
    expect(a.at).toBe(b.at);
    expect(await redis.get(ALL_TIME_LOCK_KEY)).toBeNull();
    expect(await redis.ttl(ALL_TIME_KEY)).toBeGreaterThan(0);
  });
});
