import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig } from "../src/config/app-config.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { RedisOnlineRepository } from "../src/modules/online/online.repository.js";
import { OnlineService } from "../src/modules/online/online.service.js";
import { panelSettings } from "./helpers/settings.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Счётчик онлайна на живом Redis (docs/17-testing-strategy.md §4.2; адрес —
 * PLAYTEST_TEST_REDIS_URL, без него пропуск). Подмена не покажет, что
 * `ZREMRANGEBYSCORE` и `PFADD` делают именно то, что от них ждёт пересчёт.
 *
 * Своя база Redis (сдвиг 6): ключи `online:*` общие на весь бэкенд, и
 * делить их с соседними файлами тестов нельзя.
 */

const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 6);
const NOW = new Date("2026-10-15T12:00:00.000Z");
const WINDOW_MS = 120_000;
const GAME_DAY = "2026-10-15";

describe.skipIf(REDIS_URL === "")("счётчик онлайна на живом Redis", () => {
  let redis: Redis;
  let repository: RedisOnlineRepository;
  let service: OnlineService;

  beforeAll(async () => {
    redis = createRedis(loadAppConfig({ NODE_ENV: "test", REDIS_URL } as NodeJS.ProcessEnv));
    await redis.connect();
    repository = new RedisOnlineRepository(redis);
    service = new OnlineService(repository, panelSettings({ "online.min-shown": 0, "online.run-min-shown": 0 }));
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await closeRedis(redis);
  });

  it("три аккаунта двух площадок, один — 130 с назад: онлайн двое, по площадкам верно", async () => {
    await repository.touch("a1", "telegram", NOW.getTime() - 10_000, GAME_DAY);
    await repository.touch("a2", "telegram", NOW.getTime() - 130_000, GAME_DAY);
    await repository.touch("a3", "vk", NOW.getTime() - 5_000, GAME_DAY);

    const counts = await repository.recount(NOW.getTime(), WINDOW_MS, GAME_DAY);

    expect(counts.total.app).toBe(2);
    expect(counts.byPlatform.telegram.app).toBe(1);
    expect(counts.byPlatform.vk.app).toBe(1);
    expect(counts.byPlatform.max.app).toBe(0);
    expect(counts.byPlatform.web.app).toBe(0);
    // «Сегодня играли» вышедшего из окна аккаунта не забывает.
    expect(counts.total.today).toBe(3);
    expect(counts.byPlatform.telegram.today).toBe(2);
  });

  it("пересчёт выбрасывает устаревших из набора, а не только не считает", async () => {
    await repository.touch("a1", "telegram", NOW.getTime() - 130_000, GAME_DAY);

    await repository.recount(NOW.getTime(), WINDOW_MS, GAME_DAY);

    expect(await redis.zcard("online:app:telegram")).toBe(0);
  });

  it("пинг «в забеге» и снятие: run 1, затем 0", async () => {
    await repository.touch("a1", "telegram", NOW.getTime(), GAME_DAY);

    await repository.setInRun("a1", "telegram", true, NOW.getTime());
    expect((await repository.recount(NOW.getTime(), WINDOW_MS, GAME_DAY)).total.run).toBe(1);

    await repository.setInRun("a1", "telegram", false, NOW.getTime());
    expect((await repository.recount(NOW.getTime(), WINDOW_MS, GAME_DAY)).total.run).toBe(0);
  });

  it("«в забеге» без пинга гаснет вместе с окном", async () => {
    await repository.setInRun("a1", "telegram", true, NOW.getTime() - 130_000);

    expect((await repository.recount(NOW.getTime(), WINDOW_MS, GAME_DAY)).total.run).toBe(0);
  });

  it("тот же аккаунт десять раз за сутки — today 1, два аккаунта — 2", async () => {
    for (let index = 0; index < 10; index += 1) await repository.touch("a1", "telegram", NOW.getTime() + index, GAME_DAY);
    expect((await repository.recount(NOW.getTime() + 10, WINDOW_MS, GAME_DAY)).total.today).toBe(1);

    await repository.touch("a2", "telegram", NOW.getTime(), GAME_DAY);
    expect((await repository.recount(NOW.getTime() + 10, WINDOW_MS, GAME_DAY)).total.today).toBe(2);
  });

  it("новые сутки считаются с нуля, а ключи вчерашних живут двое суток", async () => {
    await repository.touch("a1", "telegram", NOW.getTime(), GAME_DAY);

    const next = await repository.recount(NOW.getTime(), WINDOW_MS, "2026-10-16");

    expect(next.total.today).toBe(0);
    const ttl = await redis.ttl(`online:day:${GAME_DAY}`);
    expect(ttl).toBeGreaterThan(172_000);
    expect(ttl).toBeLessThanOrEqual(172_800);
  });

  it("50 параллельных отметок одного аккаунта — в сети один", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, index) => repository.touch("a1", "telegram", NOW.getTime() + index, GAME_DAY)));

    const counts = await repository.recount(NOW.getTime() + 50, WINDOW_MS, GAME_DAY);

    expect(counts.total.app).toBe(1);
    expect(counts.total.today).toBe(1);
  });

  it("посчитанное читается обратно, а до первого пересчёта ключа нет", async () => {
    expect(await repository.counts()).toBeNull();

    const counted = await repository.recount(NOW.getTime(), WINDOW_MS, GAME_DAY);

    expect(await repository.counts()).toEqual(counted);
  });

  it("битое значение вместо чисел читается как «нет чисел», а не падением", async () => {
    await redis.set("online:counts", "{не json");

    expect(await repository.counts()).toBeNull();
  });

  it("рекорд хранится значением и временем", async () => {
    expect(await repository.peak()).toBeNull();

    await repository.setPeak(42, NOW.getTime());

    expect(await repository.peak()).toEqual({ value: 42, at: NOW.getTime() });
  });

  it("сервисом целиком: активность, пинг, пересчёт, ответ с числами и рекорд", async () => {
    const claims = { accountId: "a1", platform: "telegram" as const, platformUserId: "1" };
    const other = { accountId: "a2", platform: "max" as const, platformUserId: "2" };
    service.touch(claims, NOW);
    service.touch(other, NOW);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await service.ping(claims, true, NOW);

    await service.recount(NOW);

    expect(await service.ping(claims, true, NOW)).toMatchObject({ online: 2, inRun: 1, todayPlayed: null });
    expect((await service.adminSnapshot()).peak).toEqual({ value: 2, at: NOW.getTime() });
  });
});
