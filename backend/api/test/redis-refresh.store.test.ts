import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { RedisRefreshStore } from "../src/modules/auth/redis-refresh.store.js";

/**
 * Токены продления на живом Redis. В памяти это не проверить: здесь важны
 * именно атомарность гашения Lua-скриптом, вытеснение старых устройств и
 * срок жизни набора сессий, который продлевается только вверх.
 *
 * Идёт только с PLAYTEST_TEST_REDIS_URL — отдельной базой Redis, которую тест
 * очищает целиком: `redis://localhost:6379/15`. В CI Redis пока не поднят, и
 * там тест пропускается (docs/17-testing-strategy.md §4.2).
 */
const url = process.env.PLAYTEST_TEST_REDIS_URL ?? "";

const config = (patch: Record<string, string> = {}): AppConfig =>
  loadAppConfig({
    NODE_ENV: "test",
    REDIS_URL: url,
    AUTH_ENABLED: "true",
    JWT_ACCESS_SECRET: randomBytes(32).toString("hex"),
    TELEGRAM_BOT_TOKEN: "123456:TEST",
    DATABASE_URL: "postgresql://localhost:5432/test",
    ...patch,
  } as NodeJS.ProcessEnv);

describe.skipIf(url === "")("токены продления в Redis", () => {
  let redis: Redis;
  let store: RedisRefreshStore;

  beforeAll(async () => {
    redis = createRedis(config());
    await redis.connect();
  });

  afterAll(async () => {
    await closeRedis(redis);
  });

  beforeEach(async () => {
    await redis.flushdb();
    store = new RedisRefreshStore(redis, config());
  });

  it("выданный токен забирается один раз", async () => {
    await store.issue("account-1", "hash-1", 1_000);

    expect(await store.take("hash-1")).toEqual({ status: "ok", session: { accountId: "account-1", issuedAtMs: 1_000 } });
    expect(await store.take("hash-1")).toEqual({ status: "reused", accountId: "account-1" });
  });

  it("незнакомый токен — не «повторный»: отличать важно, на повторный сбрасываются сессии", async () => {
    expect(await store.take("никогда-не-выдавался")).toEqual({ status: "unknown" });
  });

  it("два одновременных гашения — только одно успешное", async () => {
    await store.issue("account-1", "hash-1", 1_000);

    const [first, second] = await Promise.all([store.take("hash-1"), store.take("hash-1")]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["ok", "reused"]);
  });

  it("возврат оживляет погашенный токен", async () => {
    await store.issue("account-1", "hash-1", Date.now());
    const taken = await store.take("hash-1");
    if (taken.status !== "ok") throw new Error("токен должен был погаситься");

    await store.restore(taken.session, "hash-1");

    expect(await store.take("hash-1")).toMatchObject({ status: "ok" });
  });

  it("возвращать нечего, когда срок уже вышел", async () => {
    const longAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;

    await store.restore({ accountId: "account-1", issuedAtMs: longAgo }, "hash-old");

    expect(await store.take("hash-old")).toEqual({ status: "unknown" });
  });

  it("сверх потолка устройств вытесняется самое старое", async () => {
    const limited = new RedisRefreshStore(redis, config({ AUTH_MAX_SESSIONS: "2" }));
    await limited.issue("account-1", "hash-1", 1_000);
    await limited.issue("account-1", "hash-2", 2_000);
    await limited.issue("account-1", "hash-3", 3_000);

    expect(await limited.take("hash-1")).toEqual({ status: "unknown" });
    expect(await limited.take("hash-3")).toMatchObject({ status: "ok" });
  });

  it("выход со всех устройств гасит все токены аккаунта и не трогает чужие", async () => {
    await store.issue("account-1", "hash-1", 1_000);
    await store.issue("account-1", "hash-2", 2_000);
    await store.issue("account-2", "hash-3", 3_000);

    expect(await store.revokeAll("account-1")).toBe(2);
    expect(await store.take("hash-1")).toEqual({ status: "unknown" });
    expect(await store.take("hash-3")).toMatchObject({ status: "ok" });
  });

  it("срок жизни набора сессий продлевается только вверх", async () => {
    // Вход с одного устройства не должен укорачивать жизнь сессиям остальных
    // (docs/13-reuse-from-vpnsibcom.md §4).
    await store.issue("account-1", "hash-1", 1_000);
    await redis.expire("auth:sessions:account-1", 10);

    await store.issue("account-1", "hash-2", 2_000);

    expect(await redis.ttl("auth:sessions:account-1")).toBeGreaterThan(1000);
  });
});
