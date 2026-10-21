import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig } from "../src/config/app-config.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { MAX_ENTRIES, RedisCspReportsRepository, SUMMARY_TTL_SEC } from "../src/modules/csp-reports/csp-reports.repository.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Сводка отчётов политики источников на живом Redis (docs/17-testing-strategy.md
 * §4.2; адрес — PLAYTEST_TEST_REDIS_URL, без него пропуск). Подмена не покажет,
 * что потолок числа хостов держит именно Lua-скрипт при параллельной записи.
 *
 * Своя база Redis (сдвиг 9): ключи `csp:*` общие на весь бэкенд.
 */

const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 9);

describe.skipIf(REDIS_URL === "")("сводка отчётов политики источников на живом Redis", () => {
  let redis: Redis;
  let repository: RedisCspReportsRepository;

  beforeAll(async () => {
    redis = createRedis(loadAppConfig({ NODE_ENV: "test", REDIS_URL } as NodeJS.ProcessEnv));
    await redis.connect();
    repository = new RedisCspReportsRepository(redis);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await closeRedis(redis);
  });

  it("три отчёта на одну пару: счёт 3, момент — последнего", async () => {
    const hit = { directive: "script-src-elem", host: "7ool.net" };
    await repository.record(hit, 1_000);
    await repository.record(hit, 3_000);
    await repository.record(hit, 2_000);

    const { entries, overflow } = await repository.read();

    expect(entries).toEqual([{ directive: "script-src-elem", host: "7ool.net", count: 3, lastAtMs: 3_000 }]);
    expect(overflow).toBe(0);
  });

  it("разные директивы одного хоста — разные строки", async () => {
    await repository.record({ directive: "script-src", host: "a.example" }, 1);
    await repository.record({ directive: "img-src", host: "a.example" }, 2);

    const { entries } = await repository.read();

    expect(entries.map((entry) => `${entry.directive}|${entry.host}`).sort()).toEqual(["img-src|a.example", "script-src|a.example"]);
  });

  it("250 разных хостов подряд: в сводке ровно потолок, остальные посчитаны в переполнении", async () => {
    for (let index = 0; index < 250; index += 1) await repository.record({ directive: "script-src", host: `h${String(index)}.example` }, index);

    const { entries, overflow } = await repository.read();

    expect(MAX_ENTRIES).toBe(200);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(overflow).toBe(50);
  });

  it("уже учтённая пара при полной сводке продолжает расти, новая — в переполнение", async () => {
    for (let index = 0; index < MAX_ENTRIES; index += 1) await repository.record({ directive: "script-src", host: `h${String(index)}.example` }, 1);

    await repository.record({ directive: "script-src", host: "h0.example" }, 9_000);
    await repository.record({ directive: "script-src", host: "new.example" }, 9_001);

    const { entries, overflow } = await repository.read();
    const first = entries.find((entry) => entry.host === "h0.example");

    expect(first).toMatchObject({ count: 2, lastAtMs: 9_000 });
    expect(entries.some((entry) => entry.host === "new.example")).toBe(false);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(overflow).toBe(1);
  });

  it("300 записей разных хостов параллельно: не больше потолка, ничего не потеряно", async () => {
    await Promise.all(Array.from({ length: 300 }, (_, index) => repository.record({ directive: "img-src", host: `p${String(index)}.example` }, index)));

    const { entries, overflow } = await repository.read();
    const counted = entries.reduce((sum, entry) => sum + entry.count, 0);

    expect(entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(counted + overflow).toBe(300);
    expect(await redis.hlen("csp:count")).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it("срок жизни выставлен у всех трёх ключей", async () => {
    for (let index = 0; index <= MAX_ENTRIES; index += 1) await repository.record({ directive: "script-src", host: `t${String(index)}.example` }, index);

    for (const key of ["csp:count", "csp:last", "csp:overflow"]) {
      const ttl = await redis.ttl(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(SUMMARY_TTL_SEC);
    }
    expect(SUMMARY_TTL_SEC).toBe(30 * 24 * 3600);
  });

  it("в Redis лежат только директива, хост, счёт и момент", async () => {
    await repository.record({ directive: "script-src", host: "a.example" }, 5);

    const keys = (await redis.keys("*")).sort();
    const dump = JSON.stringify([await redis.hgetall("csp:count"), await redis.hgetall("csp:last")]);

    expect(keys).toEqual(["csp:count", "csp:last"]);
    expect(dump).toBe(JSON.stringify([{ "script-src|a.example": "1" }, { "script-src|a.example": "5" }]));
  });

  it("запись last без пары в count при чтении пропускается", async () => {
    await repository.record({ directive: "script-src", host: "a.example" }, 5);
    await redis.hset("csp:last", "img-src|orphan.example", "7");

    const { entries } = await repository.read();

    expect(entries.map((entry) => entry.host)).toEqual(["a.example"]);
  });

  it("пустая база — пустая сводка", async () => {
    expect(await repository.read()).toEqual({ entries: [], overflow: 0 });
  });
});
