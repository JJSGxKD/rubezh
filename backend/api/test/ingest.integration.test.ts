import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { ReportNotifier } from "../src/modules/admin-notify/report-notifier.js";
import { DiagnosticsHooks } from "../src/modules/diagnostics/diagnostics-hooks.js";
import { benchSummaryOf } from "../src/modules/diagnostics/diagnostics-summary.js";
import { PrismaDiagnosticsRepository } from "../src/modules/diagnostics/diagnostics.repository.js";
import { submitBenchReportSchema } from "../src/modules/diagnostics/dto/bench-report.dto.js";
import { PrismaExportRepository, type EventExportRow, type PageCursor } from "../src/modules/export/export.repository.js";
import { RetentionJob } from "../src/modules/export/retention.job.js";
import { benchSubmission, DEVICE } from "./helpers/bench-report.js";
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
    // Отчёт не по нынешней схеме читается как «нет» — уведомлению рисовать нечего.
    expect(await repository.findBench(record.reportId)).toBeNull();
  });

  it("читает стресс-тест обратно и шлёт одно уведомление на отчёт, сколько бы раз он ни пришёл", async () => {
    const repository = new PrismaDiagnosticsRepository(prisma);
    const reportId = randomUUID();
    const payload = submitBenchReportSchema.parse(benchSubmission(reportId));
    await repository.insert({
      reportId,
      kind: "bench",
      schemaVersion: payload.report.schema,
      appVersion: "0.4.0",
      contentHash: null,
      installId: `${install}-n`,
      platformUserId: null,
      platform: "telegram",
      device: DEVICE,
      summary: benchSummaryOf(payload),
      payload,
      sizeBytes: 100,
      occurredAt: new Date(),
      receivedAt: new Date(),
    });
    expect((await repository.findBench(reportId))?.payload.verdict.sustainedLoad).toBe(640);

    const sent: string[] = [];
    const notifyConfig = loadAppConfig({
      NODE_ENV: "test",
      DATABASE_URL,
      REDIS_URL,
      TELEGRAM_BOT_TOKEN: "123:TEST",
      ADMIN_CHAT_ID: "-100",
      DIAGNOSTICS_INGEST_ENABLED: "true",
    });
    const notifier = new ReportNotifier(notifyConfig, new DiagnosticsHooks(), repository, {
      sendPhoto: async (_chat, _photo, caption) => {
        sent.push(caption);
        return { messageId: 1, fileId: null };
      },
    });
    notifier.onApplicationBootstrap();
    try {
      const report = { reportId, kind: "bench" as const, appVersion: "0.4.0", installId: `${install}-n`, platformUserId: null, device: DEVICE, summary: benchSummaryOf(payload), payload, receivedAt: new Date() };
      await notifier.enqueue(report);
      await notifier.enqueue(report);
      for (let attempt = 0; attempt < 50 && sent.length === 0; attempt++) await sleep(100);
      await sleep(300);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(reportId);
    } finally {
      await notifier.onModuleDestroy();
    }
  });

  it("выгрузка читает страницы курсором без потерь при одинаковом времени приёма и ведёт журнал", async () => {
    const events = new PrismaEventsRepository(prisma);
    const receivedAt = "2026-09-15T09:00:00.000Z";
    const rows = Array.from({ length: 5 }, () => row(`${install}-x`, { receivedAt }));
    await events.insertMany(rows);
    const repository = new PrismaExportRepository(prisma);
    const period = { from: new Date("2026-09-15T08:59:59Z"), to: new Date("2026-09-15T09:00:01Z") };
    const seen: string[] = [];
    let cursor: PageCursor | null = null;
    for (;;) {
      const page: EventExportRow[] = await repository.eventsPage(period, cursor, 2);
      if (page.length === 0) break;
      seen.push(...page.filter((item) => item.installId === `${install}-x`).map((item) => item.eventId));
      const last = page[page.length - 1]!;
      cursor = { receivedAt: last.receivedAt, id: last.eventId };
    }
    expect(seen.sort()).toEqual(rows.map((item) => item.eventId).sort());

    const requestedBy = `t${Date.now()}`.slice(0, 16);
    const exportId = randomUUID();
    await repository.start({ exportId, source: "bot", requestedBy, period });
    expect(await repository.lastExportTo(requestedBy)).toBeNull();
    await repository.finish(exportId, { status: "sent", events: 5, reports: 0, sizeBytes: 100, parts: 1, error: null });
    expect(await repository.lastExportTo(requestedBy)).toEqual(period.to);
    await prisma.dataExport.delete({ where: { exportId } });
  });

  it("очистка удаляет только строки старше срока хранения", async () => {
    const events = new PrismaEventsRepository(prisma);
    await events.insertMany([row(`${install}-old`, { receivedAt: "2020-01-01T00:00:00.000Z" }), row(`${install}-fresh`)]);
    const job = new RetentionJob(loadAppConfig({ NODE_ENV: "test", DATABASE_URL, EVENTS_INGEST_ENABLED: "true", DIAGNOSTICS_RETENTION_DAYS: "90" }), prisma);
    const result = await job.purge(new Date("2026-09-15T12:00:00Z"));
    expect(result.events).toBeGreaterThanOrEqual(1);
    expect(await prisma.analyticsEvent.count({ where: { installId: `${install}-old` } })).toBe(0);
    expect(await prisma.analyticsEvent.count({ where: { installId: `${install}-fresh` } })).toBe(1);
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
