import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { RedisRefreshStore } from "../src/modules/auth/redis-refresh.store.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Токены продления на живом Redis. В памяти это не проверить: здесь важны
 * именно атомарность гашения Lua-скриптом, вытеснение старых устройств и
 * срок жизни набора сессий, который продлевается только вверх.
 *
 * Идёт только с PLAYTEST_TEST_REDIS_URL: `redis://localhost:6379/15`. В CI
 * Redis пока не поднят, и там тест пропускается (docs/17-testing-strategy.md
 * §4.2).
 *
 * **Своя база Redis, соседняя с той, что в переменной.** Хранилище плейтеста
 * очищает свою базу целиком (`flushdb`), а файлы тестов идут параллельно — на
 * общей базе он снёс бы эти ключи прямо посреди прогона. Сама база здесь не
 * очищается вовсе: у каждого случая свои аккаунт и токены.
 */
const url = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 1);

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
  /** Свой аккаунт на каждый случай: общая база чистится не между тестами, а никогда. */
  const account = (): string => `test-${randomUUID()}`;
  const hash = (): string => `hash-${randomUUID()}`;

  beforeAll(async () => {
    redis = createRedis(config());
    await redis.connect();
    store = new RedisRefreshStore(redis, config());
  });

  afterAll(async () => {
    await closeRedis(redis);
  });

  it("выданный токен забирается один раз", async () => {
    const [id, token] = [account(), hash()];
    await store.issue(id, token, 1_000);

    expect(await store.take(token)).toEqual({ status: "ok", session: { accountId: id, issuedAtMs: 1_000 } });
    expect(await store.take(token)).toEqual({ status: "reused", accountId: id });
  });

  it("незнакомый токен — не «повторный»: отличать важно, на повторный сбрасываются сессии", async () => {
    expect(await store.take(hash())).toEqual({ status: "unknown" });
  });

  it("два одновременных гашения — только одно успешное", async () => {
    const token = hash();
    await store.issue(account(), token, 1_000);

    const [first, second] = await Promise.all([store.take(token), store.take(token)]);

    expect([first.status, second.status].sort()).toEqual(["ok", "reused"]);
  });

  it("возврат оживляет погашенный токен", async () => {
    const token = hash();
    await store.issue(account(), token, Date.now());
    const taken = await store.take(token);
    if (taken.status !== "ok") throw new Error("токен должен был погаситься");

    await store.restore(taken.session, token);

    expect(await store.take(token)).toMatchObject({ status: "ok" });
  });

  it("возвращать нечего, когда срок уже вышел", async () => {
    const token = hash();
    const longAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;

    await store.restore({ accountId: account(), issuedAtMs: longAgo }, token);

    expect(await store.take(token)).toEqual({ status: "unknown" });
  });

  it("сверх потолка устройств вытесняется самое старое", async () => {
    const limited = new RedisRefreshStore(redis, config({ AUTH_MAX_SESSIONS: "2" }));
    const id = account();
    const [first, second, third] = [hash(), hash(), hash()];
    await limited.issue(id, first, 1_000);
    await limited.issue(id, second, 2_000);
    await limited.issue(id, third, 3_000);

    expect(await limited.take(first)).toEqual({ status: "unknown" });
    expect(await limited.take(third)).toMatchObject({ status: "ok" });
  });

  it("выход со всех устройств гасит все токены аккаунта и не трогает чужие", async () => {
    const [mine, other] = [account(), account()];
    const [first, second, alien] = [hash(), hash(), hash()];
    await store.issue(mine, first, 1_000);
    await store.issue(mine, second, 2_000);
    await store.issue(other, alien, 3_000);

    expect(await store.revokeAll(mine)).toBe(2);
    expect(await store.take(first)).toEqual({ status: "unknown" });
    expect(await store.take(alien)).toMatchObject({ status: "ok" });
  });

  it("срок жизни набора сессий продлевается только вверх", async () => {
    // Вход с одного устройства не должен укорачивать жизнь сессиям остальных
    // (docs/13-reuse-from-vpnsibcom.md §4).
    const id = account();
    await store.issue(id, hash(), 1_000);
    await redis.expire(`auth:sessions:${id}`, 10);

    await store.issue(id, hash(), 2_000);

    expect(await redis.ttl(`auth:sessions:${id}`)).toBeGreaterThan(1000);
  });
});
