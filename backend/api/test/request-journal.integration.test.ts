import "reflect-metadata";
import { Controller, Get, Global, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { DatabaseModule, PRISMA } from "../src/infra/database.js";
import { Outbound, OUTBOUND_SINK } from "../src/infra/outbound/outbound.js";
import { OutboundModule } from "../src/infra/outbound/outbound.module.js";
import { REDIS, RedisModule, closeRedis, createRedis } from "../src/infra/redis.js";
import { InboundCounter } from "../src/modules/request-journal/inbound-counter.js";
import { JOURNAL_KEEP_DAYS, LATENCY_BUCKETS_MS, minuteKey, parseInboundField } from "../src/modules/request-journal/journal-rules.js";
import { JournalRollup } from "../src/modules/request-journal/journal.rollup.js";
import { BufferedOutboundSink } from "../src/modules/request-journal/outbound-sink.js";
import { PrismaRequestJournalRepository } from "../src/modules/request-journal/request-journal.repository.js";
import { RequestJournalModule } from "../src/modules/request-journal/request-journal.module.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Журнал запросов на живых Postgres и Redis (docs/17-testing-strategy.md §4.2;
 * адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск).
 *
 * Подмена не покажет главного: что `createMany` на тысячи строк проходит
 * под лимит параметров, что `upsert` с прибавлением складывает массив
 * корзин, что лок отпускает только свой владелец, а ключ минуты на самом деле
 * исчезает после переноса.
 *
 * Свои строки тест отличает по метке в хосте и маршруте: таблицы общие на базу,
 * и чужие прогоны их не очищают друг у друга. Своя база Redis (сдвиг 12).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 12);

const HOST = "t0060.example";
const ROUTE = "/t0060/runs/:runId";
const DAY_MS = 24 * 3600_000;

/** Начало минуты за столько минут до сейчас: внутри окна, которое перебирает перенос, и уже закончившейся. */
function minuteAgo(minutes: number): Date {
  const start = Math.floor(Date.now() / 60_000) * 60_000;
  return new Date(start - minutes * 60_000);
}

describe.skipIf(DATABASE_URL === "")("журнал запросов на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaRequestJournalRepository;

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 4);
    repository = new PrismaRequestJournalRepository(prisma);
  });

  beforeEach(async () => {
    await prisma.outboundCall.deleteMany({ where: { host: HOST } });
    await prisma.inboundMinute.deleteMany({ where: { route: { startsWith: "/t0060/" } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.outboundCall.deleteMany({ where: { host: HOST } });
    await prisma.inboundMinute.deleteMany({ where: { route: { startsWith: "/t0060/" } } });
    await prisma.$disconnect();
  });

  it("каждый вызов через клиент — строка: успех и сетевой сбой, без query и секретов", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("/fail")) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    });
    const sink = new BufferedOutboundSink(repository);
    const client = new Outbound(sink).forService("telegram.bot");

    await client(`https://${HOST}/bot123:SECRET/sendMessage?chat_id=1`, { method: "POST" });
    await expect(client(`https://${HOST}/fail`)).rejects.toThrow();
    expect(await sink.flush()).toBe(2);

    const rows = await prisma.outboundCall.findMany({ where: { host: HOST }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ service: "telegram.bot", method: "POST", host: HOST, path: "/bot***/sendMessage", status: 200, ok: true, via: "direct", attempt: 1, error: null });
    expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[1]).toMatchObject({ method: "GET", path: "/fail", status: null, ok: false, error: "network" });
    const text = rows.map((row) => [row.service, row.host, row.path, row.via, row.error ?? ""].join(" ")).join("\n");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("chat_id");
  });

  it("потолок буфера — 2000 строк одним createMany, без упора в лимит параметров", async () => {
    const sink = new BufferedOutboundSink(repository);
    for (let index = 0; index < 2000; index += 1) {
      sink.write({ service: "fx.cbr", method: "GET", host: HOST, path: `/p/${String(index)}`, status: 200, ok: true, durationMs: index, via: "direct", attempt: 1, error: null, at: new Date() });
    }

    expect(await sink.flush()).toBe(2000);

    expect(await prisma.outboundCall.count({ where: { host: HOST } })).toBe(2000);
  });

  it("слишком длинные поля записываются обрезанными, а не роняют пачку", async () => {
    const sink = new BufferedOutboundSink(repository);
    sink.write({ service: "fx.cbr", method: "GET", host: HOST, path: `/${"p".repeat(500)}`, status: 200, ok: true, durationMs: 1.4, via: "direct", attempt: 1, error: null, at: new Date() });

    expect(await sink.flush()).toBe(1);

    const [row] = await prisma.outboundCall.findMany({ where: { host: HOST } });
    expect(row?.path).toHaveLength(256);
  });

  it("сводка входящих: повторная запись той же минуты прибавляет и счёт, и корзины", async () => {
    const minute = minuteAgo(10);
    const row = { minute, method: "GET", route: ROUTE, statusClass: "2xx" as const };

    await repository.addInboundMinutes([{ ...row, count: 3, buckets: [1, 1, 0, 0, 0, 0, 0, 0, 1] }]);
    await repository.addInboundMinutes([{ ...row, count: 2, buckets: [0, 1, 0, 0, 0, 0, 0, 1, 0] }, { ...row, statusClass: "5xx", count: 1, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 1] }]);

    const rows = await prisma.inboundMinute.findMany({ where: { route: ROUTE }, orderBy: { statusClass: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ statusClass: "2xx", count: 5, buckets: [1, 2, 0, 0, 0, 0, 0, 1, 1] });
    expect(rows[1]).toMatchObject({ statusClass: "5xx", count: 1 });
    expect(rows[0]?.minute).toEqual(minute);
  });

  it("уборка: строки старше семи суток удаляются, новее остаются; пачка ограничена лимитом", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (JOURNAL_KEEP_DAYS * DAY_MS + 3600_000));
    const fresh = new Date(now.getTime() - (JOURNAL_KEEP_DAYS * DAY_MS - 3600_000));
    const call = (at: Date, path: string) => ({ at, service: "fx.cbr", method: "GET", host: HOST, path, status: 200, ok: true, durationMs: 5, via: "direct", attempt: 1 });
    await prisma.outboundCall.createMany({ data: [call(old, "/o1"), call(old, "/o2"), call(old, "/o3"), call(fresh, "/f1")] });
    const inbound = (minute: Date, route: string) => ({ minute, method: "GET", route, statusClass: "2xx", count: 1, buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0] });
    await prisma.inboundMinute.createMany({ data: [inbound(old, "/t0060/old"), inbound(fresh, "/t0060/fresh")] });
    const cutoff = new Date(now.getTime() - JOURNAL_KEEP_DAYS * DAY_MS);

    // Лимит пачки соблюдается: за раз уходит не больше двух из трёх старых.
    expect(await repository.deleteOutboundBefore(cutoff, 2)).toBe(2);
    while ((await repository.deleteOutboundBefore(cutoff, 2)) > 0) continue;
    while ((await repository.deleteInboundBefore(cutoff, 5000)) > 0) continue;

    expect((await prisma.outboundCall.findMany({ where: { host: HOST } })).map((row) => row.path)).toEqual(["/f1"]);
    expect((await prisma.inboundMinute.findMany({ where: { route: { startsWith: "/t0060/" } } })).map((row) => row.route)).toEqual(["/t0060/fresh"]);
  });
});

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("журнал запросов на живых Postgres и Redis", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let repository: PrismaRequestJournalRepository;
  let rollup: JournalRollup;
  let counter: InboundCounter;

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 4);
    redis = createRedis(loadAppConfig({ NODE_ENV: "test", REDIS_URL } as NodeJS.ProcessEnv));
    await redis.connect();
    repository = new PrismaRequestJournalRepository(prisma);
    rollup = new JournalRollup(redis, repository);
    counter = new InboundCounter(redis);
  });

  beforeEach(async () => {
    await redis.flushdb();
    await prisma.outboundCall.deleteMany({ where: { host: HOST } });
    await prisma.inboundMinute.deleteMany({ where: { route: { startsWith: "/t0060/" } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.outboundCall.deleteMany({ where: { host: HOST } });
    await prisma.inboundMinute.deleteMany({ where: { route: { startsWith: "/t0060/" } } });
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("три ответа в минуту — после переноса одна строка со счётом 3 и корзинами, ключ минуты исчез", async () => {
    const minute = minuteAgo(10);
    const at = new Date(minute.getTime() + 10_000);

    await counter.count("GET", ROUTE, 200, 20, at);
    await counter.count("GET", ROUTE, 204, 30, at);
    await counter.count("GET", ROUTE, 200, 9000, at);
    expect(await redis.exists(minuteKey(at))).toBe(1);
    expect(await redis.ttl(minuteKey(at))).toBeGreaterThan(7100);

    await rollup.rollInbound(new Date());

    const rows = await prisma.inboundMinute.findMany({ where: { route: ROUTE } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "GET", statusClass: "2xx", count: 3, buckets: [1, 1, 0, 0, 0, 0, 0, 0, 1] });
    expect(rows[0]?.minute).toEqual(minute);
    expect(rows[0]?.buckets).toHaveLength(LATENCY_BUCKETS_MS.length + 1);
    expect(await redis.exists(minuteKey(at))).toBe(0);
  });

  it("повторный перенос той же минуты не задваивает; запоздавшая запись прибавляется", async () => {
    const minute = minuteAgo(10);
    const at = new Date(minute.getTime() + 10_000);
    await counter.count("GET", ROUTE, 200, 20, at);
    await counter.count("GET", ROUTE, 200, 20, at);

    await rollup.rollInbound(new Date());
    await rollup.rollInbound(new Date());
    expect((await prisma.inboundMinute.findMany({ where: { route: ROUTE } }))[0]?.count).toBe(2);

    await counter.count("GET", ROUTE, 200, 20, at);
    await rollup.rollInbound(new Date());
    const [row] = await prisma.inboundMinute.findMany({ where: { route: ROUTE } });
    expect(row?.count).toBe(3);
    expect(row?.buckets[0]).toBe(3);
  });

  it("текущая минута остаётся в Redis", async () => {
    await counter.count("GET", ROUTE, 200, 20, new Date());

    await rollup.rollInbound(new Date());

    expect(await prisma.inboundMinute.count({ where: { route: ROUTE } })).toBe(0);
  });

  it("уборка через проход: старые строки обеих таблиц уходят, новые остаются, метка суток не даёт повторить", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (JOURNAL_KEEP_DAYS * DAY_MS + 3600_000));
    const fresh = new Date(now.getTime() - 3600_000);
    const call = (at: Date, path: string) => ({ at, service: "fx.cbr", method: "GET", host: HOST, path, status: 200, ok: true, durationMs: 5, via: "direct", attempt: 1 });
    await prisma.outboundCall.createMany({ data: [call(old, "/o1"), call(old, "/o2"), call(old, "/o3"), call(fresh, "/f1")] });
    await prisma.inboundMinute.createMany({
      data: [
        { minute: old, method: "GET", route: "/t0060/old", statusClass: "2xx", count: 1, buckets: [1] },
        { minute: fresh, method: "GET", route: "/t0060/fresh", statusClass: "2xx", count: 1, buckets: [1] },
      ],
    });

    // Пачка по 2: цикл обязан идти, пока пачка полная.
    const cleaned = await rollup.cleanup(now, 2);
    expect(cleaned.outbound).toBeGreaterThanOrEqual(3);
    expect(cleaned.inbound).toBeGreaterThanOrEqual(1);

    expect((await prisma.outboundCall.findMany({ where: { host: HOST } })).map((row) => row.path)).toEqual(["/f1"]);
    expect((await prisma.inboundMinute.findMany({ where: { route: { startsWith: "/t0060/" } } })).map((row) => row.route)).toEqual(["/t0060/fresh"]);

    await rollup.tick(now);
    expect(await redis.exists("request-journal:lock")).toBe(0);
    const marks = (await redis.keys("request-journal:*")).filter((key) => key !== "request-journal:lock");
    expect(marks).toHaveLength(1);
    expect(await redis.ttl(marks[0] ?? "")).toBeGreaterThan(0);
  });

  it("лок: пока он у другой реплики, проход не идёт; после — идёт и отпускает свой лок", async () => {
    await redis.set("request-journal:lock", "чужая-реплика", "PX", 30_000, "NX");

    expect(await rollup.tick()).toBeNull();
    expect(await redis.get("request-journal:lock")).toBe("чужая-реплика");

    await redis.del("request-journal:lock");
    expect(await rollup.tick()).not.toBeNull();
    expect(await redis.exists("request-journal:lock")).toBe(0);
  });

  it("/health не попадает в сводку, остальные ответы считаются по шаблону маршрута", async () => {
    @Controller("health")
    class HealthStubController {
      @Get()
      check(): { status: string } {
        return { status: "ok" };
      }

      @Get("ready")
      ready(): { status: string } {
        return { status: "ok" };
      }
    }
    @Controller("t0060")
    class T0060Controller {
      @Get("runs/:runId")
      run(@Param("runId") runId: string): { runId: string } {
        return { runId };
      }
    }
    @Module({
      controllers: [HealthStubController, T0060Controller],
      providers: [{ provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", REDIS_URL } as NodeJS.ProcessEnv) }, { provide: REDIS, useValue: redis }, InboundCounter],
    })
    class TestModule {}
    const app = await createHttpApp(TestModule, { logger: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      await app.inject({ method: "GET", url: "/health" });
      await app.inject({ method: "GET", url: "/health/ready" });
      await app.inject({ method: "GET", url: "/api/v1/t0060/runs/aaa" });
      await app.inject({ method: "GET", url: "/api/v1/t0060/runs/bbb" });
      await app.inject({ method: "GET", url: "/api/v1/t0060/runs/ccc" });

      // Хук `onResponse` срабатывает после ответа: ждём, пока три учтённых запроса осядут в Redis.
      await vi.waitFor(async () => {
        let hits = 0;
        for (const key of await redis.keys("inbound:m:*")) {
          for (const [field, value] of Object.entries(await redis.hgetall(key))) {
            if (parseInboundField(field)?.slot === "n") hits += Number(value);
          }
        }
        expect(hits).toBe(3);
      });
      await rollup.rollInbound(new Date(Date.now() + 120_000));

      const rows = await prisma.inboundMinute.findMany({ where: { route: { contains: "t0060" } } });
      expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
      expect(rows.every((row) => row.route === "/api/v1/t0060/runs/:runId")).toBe(true);
      expect(await prisma.inboundMinute.count({ where: { route: { startsWith: "/health" } } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("приложение: клиент исходящих пишет в базу через модуль журнала, при остановке буфер сбрасывается", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    @Global()
    @Module({ providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] })
    class ConfigStub {}
    @Module({ imports: [ConfigStub, RedisModule, DatabaseModule, OutboundModule, RequestJournalModule] })
    class Root {}
    const context = await NestFactory.createApplicationContext(Root, { logger: false });
    let closed = false;
    try {
      expect(context.get(OUTBOUND_SINK)).toBeInstanceOf(BufferedOutboundSink);
      expect(context.get(PRISMA)).toBeDefined();
      const client = context.get(Outbound).forService("fx.cbr");

      await client(`https://${HOST}/daily`);
      await context.get(BufferedOutboundSink).flush();
      expect(await prisma.outboundCall.count({ where: { host: HOST, path: "/daily" } })).toBe(1);

      await client(`https://${HOST}/on-shutdown`);
      await context.close();
      closed = true;
      expect(await prisma.outboundCall.count({ where: { host: HOST, path: "/on-shutdown" } })).toBe(1);
    } finally {
      if (!closed) await context.close();
    }
  });
});
