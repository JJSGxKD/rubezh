import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaDiagnosticsRepository } from "../src/modules/diagnostics/diagnostics.repository.js";
import { PrismaEventsRepository, type EventRow } from "../src/modules/events/events.repository.js";
import { QueuedEventsSink } from "../src/modules/events/events.sink.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";

// Приёмники на настоящих Postgres и Redis (docs/17-testing-strategy.md §4.2).
// Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL; без них тесты пропускаются.

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
const live = DATABASE_URL !== "" && REDIS_URL !== "";

function row(installId: string, patch: Partial<EventRow> = {}): EventRow {
  return {
    eventId: randomUUID(),
    eventType: "run_started",
    schemaVersion: 1,
    installId,
    platformUserId: null,
    sessionId: "session-1",
    platform: "telegram",
    appVersion: "0.4.0",
    payload: { seed: 1 },
    occurredAt: "2026-09-15T10:00:00.000Z",
    receivedAt: "2026-09-15T10:00:01.000Z",
    ...patch,
  };
}

describe.skipIf(!live)("приёмники на живых Postgres и Redis", () => {
  // У каждого прогона свой префикс установки: файлы тестов идут параллельно,
  // и чистить таблицы целиком нельзя.
  const install = `test-${randomUUID()}`;
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL, EVENTS_INGEST_ENABLED: "true" });
    prisma = createPrisma(config);
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await prisma.analyticsEvent.deleteMany({ where: { installId: { startsWith: install } } });
    await prisma.diagnosticReport.deleteMany({ where: { installId: { startsWith: install } } });
    await prisma.$disconnect();
    redis.disconnect();
  });

  it("повтор отчёта диагностики — одна строка, второй раз «дубликат»", async () => {
    const repository = new PrismaDiagnosticsRepository(prisma);
    const record = {
      reportId: randomUUID(),
      kind: "bench" as const,
      schemaVersion: "rubezh.bench.v4",
      appVersion: "0.4.0",
      contentHash: null,
      installId: `${install}-r`,
      platformUserId: null,
      platform: "telegram" as const,
      device: { clientPlatform: "android", clientVersion: "8.0", os: "android" as const, formFactor: "phone" as const, screenWidth: 412, screenHeight: 915, pixelRatio: 2.6, cores: 8, memoryGb: null },
      summary: { peakObjects: 1200 },
      payload: { timeline: [] },
      sizeBytes: 20,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
      receivedAt: new Date("2026-09-15T10:00:01Z"),
    };
    const results = await Promise.all([repository.insert(record), repository.insert(record)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repository.insert(record)).toBe(false);
    expect(await prisma.diagnosticReport.count({ where: { installId: `${install}-r` } })).toBe(1);
  });

  it("повтор пачки — одна запись на событие", async () => {
    const repository = new PrismaEventsRepository(prisma);
    const rows = [row(`${install}-a`), row(`${install}-a`)];
    expect(await repository.insertMany(rows)).toBe(2);
    expect(await repository.insertMany(rows)).toBe(0);
    expect(await prisma.analyticsEvent.count({ where: { installId: `${install}-a` } })).toBe(2);
  });

  it("параллельные запросы не пробивают лимит: счётчик атомарен", async () => {
    const limiter = new RateLimiter(redis);
    const rule = { scope: `test:${randomUUID()}`, limit: 10, windowSec: 60 };
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter.consume(rule, "key")));
    expect(results.filter(Boolean)).toHaveLength(10);
    const ttl = await redis.ttl(`rl:${rule.scope}:key:${Math.floor(Date.now() / 1000 / 60)}`);
    expect(ttl).toBeGreaterThan(0);
  });

  it("очередь доносит пачку до базы, а без Redis пачка пишется напрямую", async () => {
    const repository = new PrismaEventsRepository(prisma);
    const sink = new QueuedEventsSink(config, repository);
    sink.onApplicationBootstrap();
    try {
      await sink.write([row(`${install}-q`), row(`${install}-q`)]);
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await prisma.analyticsEvent.count({ where: { installId: `${install}-q` } })) === 2) break;
        await sleep(100);
      }
      expect(await prisma.analyticsEvent.count({ where: { installId: `${install}-q` } })).toBe(2);
    } finally {
      await sink.onModuleDestroy();
    }

    const broken = new QueuedEventsSink(loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL: "redis://127.0.0.1:1", EVENTS_INGEST_ENABLED: "true" }), repository);
    broken.onApplicationBootstrap();
    try {
      await broken.write([row(`${install}-d`)]);
      expect(await prisma.analyticsEvent.count({ where: { installId: `${install}-d` } })).toBe(1);
    } finally {
      await broken.onModuleDestroy();
    }
  });
});
