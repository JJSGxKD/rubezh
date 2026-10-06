import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RedisPanelLoginStore, type PanelLoginRequest } from "../src/modules/admin/panel-login.store.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Запросы входа в панель на живом Redis: подтверждение и выдача атомарны —
 * из двух одновременных нажатий проходит одно, из двух опросов сессию
 * получает один; у запроса есть срок. Без Redis — пропуск.
 */

const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 5);

const request = (patch: Partial<PanelLoginRequest> = {}): PanelLoginRequest => ({
  secretHash: "a".repeat(64),
  code: "4821",
  device: "Chrome · Windows",
  place: "95.24.*.*",
  createdAtMs: Date.now(),
  status: "pending",
  accountId: null,
  reason: null,
  ...patch,
});

describe.skipIf(REDIS_URL === "")("запросы входа в панель на живом Redis", () => {
  let redis: Redis;
  let store: RedisPanelLoginStore;
  const id = () => randomBytes(16).toString("base64url");

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
    store = new RedisPanelLoginStore(redis);
  });

  afterAll(() => {
    redis.disconnect();
  });

  it("запись читается обратно, у неё есть срок", async () => {
    const requestId = id();
    await store.create(requestId, request(), 300);
    expect(await store.get(requestId)).toMatchObject({ code: "4821", status: "pending", accountId: null, reason: null });
    const ttl = await redis.ttl(`admin:panel-login:${requestId}`);
    expect(ttl).toBeGreaterThan(290);
    expect(await store.get(id())).toBeNull();
  });

  it("из двух одновременных подтверждений проходит одно, срок остаётся", async () => {
    const requestId = id();
    await store.create(requestId, request(), 300);
    const results = await Promise.all([store.settle(requestId, "confirmed", "acc-1", null), store.settle(requestId, "declined", null, "declined")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await redis.ttl(`admin:panel-login:${requestId}`)).toBeGreaterThan(290);
  });

  it("подтверждённый забирается один раз, ждущий и отклонённый — никогда", async () => {
    const confirmed = id();
    await store.create(confirmed, request(), 300);
    await store.settle(confirmed, "confirmed", "acc-1", null);
    const taken = await Promise.all([store.take(confirmed), store.take(confirmed)]);
    expect(taken.filter((account) => account !== null)).toEqual(["acc-1"]);
    expect(await store.get(confirmed)).toBeNull();

    const pending = id();
    await store.create(pending, request(), 300);
    expect(await store.take(pending)).toBeNull();
    await store.settle(pending, "declined", null, "declined");
    expect(await store.take(pending)).toBeNull();
    expect(await store.get(pending)).toMatchObject({ status: "declined", reason: "declined" });
  });

  it("битая запись — как отсутствующая", async () => {
    const requestId = id();
    await redis.hset(`admin:panel-login:${requestId}`, { secretHash: "короткий", status: "pending" });
    await redis.expire(`admin:panel-login:${requestId}`, 60);
    expect(await store.get(requestId)).toBeNull();
  });
});
