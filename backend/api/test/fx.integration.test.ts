import { randomUUID } from "node:crypto";
import { quoteInUsd, type RateSource } from "@bh/fx";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis } from "../src/infra/redis.js";
import { FxHooks, type FxAlert } from "../src/modules/fx/fx-hooks.js";
import { FxRefreshBusyError, FxRefresher } from "../src/modules/fx/fx.refresher.js";
import { PrismaRateStore } from "../src/modules/fx/fx.store.js";
import { environmentSecrets } from "../src/modules/secrets/secrets.service.js";
import { rateStoreContract } from "../../../packages/fx/test/store-contract.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * Хранилище курсов на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск). Тот же контракт, что проходит
 * хранилище в памяти ядра: ядро не знает про Prisma, и совместимость держит
 * тест.
 *
 * Память этого не покажет: курс в `numeric(80, 50)` без потери знаков,
 * массив источников, снимок в JSON и обратно через схему.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 10);

describe.skipIf(DATABASE_URL === "")("хранилище курсов на живом Postgres", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Курс валюты — один на базу, поэтому каждый случай начинается с пустых
  // таблиц курсов. Другие тесты их не трогают.
  rateStoreContract(async () => {
    await prisma.$executeRaw`TRUNCATE fx_quote, fx_rate_current, fx_rate_history, fx_manual_rate, fx_snapshot, fx_source_state`;
    return { store: new PrismaRateStore(prisma), source: (name) => name };
  });
});

/**
 * Лимиты источников из панели (docs/35-stage4-plan.md, Р89, T-0062) на живых
 * Postgres и Redis: строка лимита и правка счётчика одним запросом — в базе,
 * «порог впервые за месяц» — в Redis, и вторая реплика второго сообщения не даст.
 */
describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("лимиты источников курсов на живых Postgres и Redis", () => {
  const NOW = new Date("2026-09-25T12:00:00Z");
  const actor = randomUUID();
  let prisma: PrismaClient;
  let redis: Redis;
  let store: PrismaRateStore;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    store = new PrismaRateStore(prisma);
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE fx_source_limit, fx_source_state, fx_quote, fx_rate_current, fx_rate_history`;
    await redis.flushdb();
  });

  /** Источник без месячного лимита в коде: лимит ему задан в панели. */
  function fakeSource(): RateSource {
    return {
      id: "fake",
      currencies: [],
      tariff: { name: "test", perMinute: 60, perMonth: null, minIntervalMs: 60_000 },
      async fetch() {
        return [quoteInUsd("GRAM", "1.43", "fake", NOW)];
      },
    };
  }

  it("лимит записывается, заменяется, «без лимита» остаётся значением, сброс убирает строку", async () => {
    await store.setLimit("coingecko", 20_000, "поставщик поднял тариф", actor, NOW);
    expect((await store.limits()).get("coingecko")).toEqual({ perMonth: 20_000, note: "поставщик поднял тариф", updatedBy: actor, updatedAt: NOW });

    const later = new Date(NOW.getTime() + 60_000);
    await store.setLimit("coingecko", null, "безлимитный план", actor, later);
    const row = (await store.limits()).get("coingecko");
    expect(row).toEqual({ perMonth: null, note: "безлимитный план", updatedBy: actor, updatedAt: later });
    expect((await store.limits()).size).toBe(1);

    await store.resetLimit("coingecko");
    expect((await store.limits()).has("coingecko")).toBe(false);
    // Сброс того, чего нет, — не ошибка.
    await expect(store.resetLimit("coingecko")).resolves.toBeUndefined();
  });

  it("setUsed меняет счётчик и месяц, паузу и срок следующего опроса не трогает", async () => {
    const pausedUntil = new Date("2026-09-25T13:00:00Z");
    const nextPollAt = new Date("2026-09-25T12:30:00Z");
    await store.saveSourceState("coingecko", { usage: { month: "2026-08", used: 9_000, pausedUntil }, nextPollAt });

    await store.setUsed("coingecko", 50, "2026-09", NOW);
    expect(await store.sourceState("coingecko")).toEqual({ usage: { month: "2026-09", used: 50, pausedUntil }, nextPollAt });

    await store.setUsed("coingecko", 0, "2026-09", NOW);
    expect((await store.sourceState("coingecko"))?.usage.used).toBe(0);
  });

  it("setUsed источнику, которого ещё не опрашивали, заводит состояние с опросом «пора»", async () => {
    await store.setUsed("tonapi", 12, "2026-09", NOW);
    expect(await store.sourceState("tonapi")).toEqual({ usage: { month: "2026-09", used: 12, pausedUntil: null }, nextPollAt: NOW });
  });

  it("ближайший опрос только приближается: позже названного срока — сдвиг, раньше — без изменений", async () => {
    const nextPollAt = new Date("2026-10-01T00:00:00Z");
    await store.saveSourceState("coingecko", { usage: { month: "2026-09", used: 10_000, pausedUntil: null }, nextPollAt });

    const sooner = new Date("2026-09-25T12:05:00Z");
    await store.pullPollForward("coingecko", sooner);
    expect((await store.sourceState("coingecko"))?.nextPollAt).toEqual(sooner);

    await store.pullPollForward("coingecko", new Date("2026-09-30T00:00:00Z"));
    expect((await store.sourceState("coingecko"))?.nextPollAt).toEqual(sooner);

    // Нет состояния — нечего приближать, и строка не заводится.
    await store.pullPollForward("binance", sooner);
    expect(await store.sourceState("binance")).toBeNull();
  });

  it("порог 80% даёт одно событие за месяц, второй проход — ни одного", async () => {
    await store.setLimit("fake", 10, "тест", actor, NOW);
    const hooks = new FxHooks();
    const alerts: FxAlert[] = [];
    hooks.onAlert("test", async (alert) => void alerts.push(alert));
    const config = loadAppConfig({ NODE_ENV: "test", FX_ENABLED: "true" } as NodeJS.ProcessEnv);
    const refresher = new FxRefresher(environmentSecrets(config), store, redis, hooks, switchesOf(config));
    const due = new Date(NOW.getTime() - 1000);
    const seed = (used: number) => store.saveSourceState("fake", { usage: { month: "2026-09", used, pausedUntil: null }, nextPollAt: due });
    const budget = () => alerts.filter((alert) => alert.kind === "source_budget");

    await seed(7);
    await refresher.tick([fakeSource()], NOW);
    await new Promise((resolve) => setImmediate(resolve));
    expect(budget()).toEqual([{ kind: "source_budget", source: "fake", month: "2026-09", used: 8, perMonth: 10, threshold: 80 }]);

    // Тот же месяц, счётчик снова проходит 80% — повтор прохода или вторая реплика.
    await seed(7);
    await refresher.tick([fakeSource()], NOW);
    await new Promise((resolve) => setImmediate(resolve));
    expect(budget()).toHaveLength(1);

    const ttl = await redis.ttl("fx:budget:fake:2026-09:80");
    expect(ttl).toBeGreaterThan(3_000_000);
    expect(ttl).toBeLessThanOrEqual(3_024_000);
    // Лок прохода снят, порог 100% ещё не тронут.
    expect(await redis.exists("fx:refresh:lock")).toBe(0);
    expect(await redis.exists("fx:budget:fake:2026-09:100")).toBe(0);
  });

  it("«Обновить сейчас» и проход по расписанию одновременно: опрос один, второй получает отказ или пропуск (T-0064)", async () => {
    const config = loadAppConfig({ NODE_ENV: "test", FX_ENABLED: "true" } as NodeJS.ProcessEnv);
    const make = () => new FxRefresher(environmentSecrets(config), store, redis, new FxHooks(), switchesOf(config));
    const replicaA = make();
    const replicaB = make();
    let calls = 0;
    // Опрос длится, пока вторая реплика пробует взять тот же лок.
    const slow: RateSource = {
      ...fakeSource(),
      async fetch() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [quoteInUsd("GRAM", "1.43", "fake", NOW)];
      },
    };
    await store.saveSourceState("fake", { usage: { month: "2026-09", used: 0, pausedUntil: null }, nextPollAt: new Date(NOW.getTime() - 1000) });

    const [tick, now] = await Promise.allSettled([replicaA.tick([slow], NOW), replicaB.refreshNow("fake", NOW, [slow])]);

    expect(calls).toBe(1);
    // Выиграл один: либо проход ответил отчётом, а «сейчас» — отказом, либо наоборот.
    const tickRan = tick.status === "fulfilled" && tick.value !== null;
    const nowRan = now.status === "fulfilled";
    expect(Number(tickRan) + Number(nowRan)).toBe(1);
    if (!nowRan) expect((now as PromiseRejectedResult).reason).toBeInstanceOf(FxRefreshBusyError);
    expect(await redis.exists("fx:refresh:lock")).toBe(0);
    expect((await store.sourceState("fake"))?.usage.used).toBe(1);
  });
});
