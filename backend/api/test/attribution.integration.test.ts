import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RedisSessionDedupe } from "../src/modules/attribution/session-dedupe.js";
import { PrismaSessionsRepository, type SessionRecord } from "../src/modules/attribution/sessions.repository.js";
import type { StartKind } from "../src/modules/attribution/start-param.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Сессии и касания на настоящих Postgres и Redis (docs/17-testing-strategy.md
 * §4.2). Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL; без них
 * пропускается.
 *
 * Память этого не покажет: касания считает одна вставка с `ON CONFLICT`, и
 * только настоящая база скажет, что параллельные сессии дают одну строку, а
 * первое касание не переписывается поздней записью. Redis — своя база
 * (сдвиг 3): ключи окна общие на аккаунт.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 3);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);

describe.skipIf(!live)("сессии и касания на живых Postgres и Redis", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessions: PrismaSessionsRepository;
  let accounts: PrismaAccountRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Путник", username: null, photoUrl: null },
      Date.now(),
    );
    return created.accountId;
  }

  function session(accountId: string, kind: StartKind, atMs: number, patch: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: randomUUID(),
      accountId,
      platform: "telegram",
      place: "miniapp",
      startKind: kind,
      startParam: kind === "organic" ? null : kind === "click" ? "c-Ab12Cd34" : "invite",
      startRef: kind === "click" ? "Ab12Cd34" : null,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: "203.0.113.0/24",
      startedAt: new Date(atMs).toISOString(),
      ...patch,
    };
  }

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    sessions = new PrismaSessionsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("первое касание не переписывается вторым, последнее — переписывается", async () => {
    const id = await account();

    await sessions.record(session(id, "organic", T0));
    await sessions.record(session(id, "click", T0 + 60_000));

    await expect(sessions.acquisition(id)).resolves.toMatchObject({
      firstStartKind: "organic",
      firstAt: new Date(T0),
      lastStartKind: "click",
      lastStartRef: "Ab12Cd34",
      lastTouchAt: new Date(T0 + 60_000),
    });
  });

  it("органический запуск не стирает кампанию, которая вернула игрока", async () => {
    const id = await account();

    await sessions.record(session(id, "click", T0));
    await sessions.record(session(id, "organic", T0 + 3_600_000));

    await expect(sessions.acquisition(id)).resolves.toMatchObject({
      lastStartKind: "click",
      lastTouchAt: new Date(T0),
      lastSeenAt: new Date(T0 + 3_600_000),
    });
  });

  it("запись, опоздавшая в очереди, первое касание всё равно отдаёт самой ранней сессии", async () => {
    const id = await account();

    await sessions.record(session(id, "invite", T0 + 60_000));
    await sessions.record(session(id, "click", T0));

    await expect(sessions.acquisition(id)).resolves.toMatchObject({ firstStartKind: "click", firstAt: new Date(T0), lastStartKind: "invite" });
  });

  it("подсети последних сессий — свежие первыми, без повторов и пустых", async () => {
    const id = await account();
    await sessions.record({ ...session(id, "click", T0), ipPrefix: "10.1.2.0/24" });
    await sessions.record({ ...session(id, "invite", T0 + 60_000), ipPrefix: "10.9.9.0/24" });
    await sessions.record({ ...session(id, "invite", T0 + 120_000), ipPrefix: "10.1.2.0/24" });
    await sessions.record({ ...session(id, "organic", T0 + 180_000), ipPrefix: null });

    expect(await sessions.recentIpPrefixes(id, 10)).toEqual(["10.1.2.0/24", "10.9.9.0/24"]);
  });

  it("последняя сессия до момента — без сессий этого момента и позже", async () => {
    const id = await account();
    expect(await sessions.lastSessionBefore(id, new Date(T0))).toBeNull();
    await sessions.record(session(id, "click", T0));
    await sessions.record(session(id, "invite", T0 + 3_600_000));
    expect(await sessions.lastSessionBefore(id, new Date(T0 + 3_600_000))).toEqual(new Date(T0));
    expect(await sessions.lastSessionBefore(id, new Date(T0 + 7_200_000))).toEqual(new Date(T0 + 3_600_000));
  });

  it("повтор того же задания — одна сессия, касания не сдвигаются", async () => {
    const id = await account();
    const same = session(id, "click", T0);

    await expect(sessions.record(same)).resolves.toBe("recorded");
    await expect(sessions.record(same)).resolves.toBe("duplicate");

    expect(await prisma.accountSession.count({ where: { accountId: id } })).toBe(1);
  });

  it("параллельные сессии нового игрока — одна строка касаний", async () => {
    const id = await account();

    await Promise.all(Array.from({ length: 6 }, (_, index) => sessions.record(session(id, index % 2 === 0 ? "organic" : "click", T0 + index * 1000))));

    expect(await prisma.accountSession.count({ where: { accountId: id } })).toBe(6);
    expect(await prisma.acquisition.count({ where: { accountId: id } })).toBe(1);
    await expect(sessions.acquisition(id)).resolves.toMatchObject({ firstAt: new Date(T0), lastTouchAt: new Date(T0 + 5000) });
  });

  it("окно в Redis отсекает повтор запуска, но не запуск по новой ссылке", async () => {
    const dedupe = new RedisSessionDedupe(redis);
    const id = randomUUID();

    await expect(dedupe.claim(id, "c-Ab12Cd34")).resolves.toBe(true);
    await expect(dedupe.claim(id, "c-Ab12Cd34")).resolves.toBe(false);
    await expect(dedupe.claim(id, null)).resolves.toBe(true);
    // Окно живёт своё время и исчезает само — ключи не копятся.
    const keys = await redis.keys(`session:recent:${id}:*`);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(await redis.ttl(key)).toBeGreaterThan(0);
    for (const key of keys) expect(await redis.ttl(key)).toBeLessThanOrEqual(30);
  });
});
