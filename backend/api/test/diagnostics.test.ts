import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { DiagnosticsController } from "../src/modules/diagnostics/diagnostics.controller.js";
import { DiagnosticsHooks, type ReceivedReport } from "../src/modules/diagnostics/diagnostics-hooks.js";
import {
  DIAGNOSTICS_REPOSITORY,
  type DiagnosticsRepository,
  type ReportRecord,
} from "../src/modules/diagnostics/diagnostics.repository.js";
import { DiagnosticsService } from "../src/modules/diagnostics/diagnostics.service.js";
import { IngestGuard } from "../src/modules/ingest/ingest.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { reportEnvelope, REPORT_ID } from "./helpers/bench-report.js";
import { launchFor } from "./helpers/init-data.js";

// Приёмник отчётов диагностики (docs/28-diagnostics.md §5).

const TOKEN = "123456:TEST-diagnostics";
const ADMIN = 555000111;

class MemoryRepository implements DiagnosticsRepository {
  readonly records = new Map<string, ReportRecord>();
  failure: Error | null = null;
  async insert(record: ReportRecord): Promise<boolean> {
    if (this.failure !== null) throw this.failure;
    if (this.records.has(record.reportId)) return false;
    this.records.set(record.reportId, record);
    return true;
  }
  async findBench(): Promise<null> {
    return null;
  }
}

const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

describe("приёмник отчётов диагностики", () => {
  let app: NestFastifyApplication | null = null;
  let repository: MemoryRepository;
  let received: ReceivedReport[];

  async function start(env: Record<string, string> = {}): Promise<NestFastifyApplication> {
    repository = new MemoryRepository();
    received = [];
    const hooks = new DiagnosticsHooks();
    hooks.onReport("test", async (report) => {
      received.push(report);
    });
    const config = loadAppConfig({
      NODE_ENV: "test",
      DIAGNOSTICS_INGEST_ENABLED: "true",
      DATABASE_URL: "postgresql://unused",
      TELEGRAM_BOT_TOKEN: TOKEN,
      PLAYTEST_ENABLED: "true",
      ADMIN_TELEGRAM_IDS: String(ADMIN),
      ...env,
    });
    @Module({
      controllers: [DiagnosticsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: DIAGNOSTICS_REPOSITORY, useValue: repository },
        { provide: DiagnosticsHooks, useValue: hooks },
        RateLimiter,
        IngestGuard,
        DiagnosticsService,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function post(target: NestFastifyApplication, body: unknown, headers: Record<string, string> = {}) {
    return target.inject({ method: "POST", url: "/api/v1/diagnostics/reports", headers, payload: body as object });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("пишет отчёт с итогом для выборок, а повтор помечает дубликатом и не шлёт дальше", async () => {
    const target = await start();
    const first = await post(target, reportEnvelope(), { authorization: `tma ${launchFor(777000111, TOKEN)}` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ data: { reportId: REPORT_ID, duplicate: false } });
    const second = await post(target, reportEnvelope());
    expect(second.json()).toEqual({ data: { reportId: REPORT_ID, duplicate: true } });
    await settle();

    const record = repository.records.get(REPORT_ID);
    expect(record).toMatchObject({
      kind: "bench",
      schemaVersion: "rubezh.bench.v4",
      appVersion: "0.4.0",
      platformUserId: "777000111",
      summary: { outcome: "degradation", peakObjects: 1211, sustainedLoad: 640, breakingLoad: 660, verdict: "no-go" },
    });
    expect(record?.sizeBytes).toBeGreaterThan(500);
    expect(received).toHaveLength(1);
  });

  it("не записывает Telegram ID и строку браузера из тела отчёта", async () => {
    const target = await start();
    await post(target, reportEnvelope(), { authorization: `tma ${launchFor(777000111, "999:чужой")}` });
    const record = repository.records.get(REPORT_ID);
    expect(record?.platformUserId).toBeNull();
    expect(JSON.stringify(record?.payload)).not.toContain("777000111");
    expect(JSON.stringify(record?.payload)).not.toContain('"userAgent":"ua"');
  });

  it("вне плейтеста стресс-тест принимает только от администратора", async () => {
    const target = await start({ PLAYTEST_ENABLED: "false" });
    expect((await post(target, reportEnvelope())).statusCode).toBe(403);
    const admin = await post(target, reportEnvelope(), { authorization: `tma ${launchFor(ADMIN, TOKEN)}` });
    expect(admin.statusCode).toBe(200);
  });

  it("отклоняет отчёт не по схеме и чужой reportId внутри", async () => {
    const target = await start();
    expect((await post(target, reportEnvelope(REPORT_ID, { kind: "run" }))).statusCode).toBe(400);
    const mismatched = reportEnvelope("22222222-2222-4333-8444-555555555555");
    (mismatched.payload as Record<string, unknown>).reportId = REPORT_ID;
    expect((await post(target, mismatched)).statusCode).toBe(400);
    expect(repository.records.size).toBe(0);
  });

  it("выключенный приёмник отвечает 404, недоступная база — 503", async () => {
    const off = await start({ DIAGNOSTICS_INGEST_ENABLED: "false" });
    expect((await post(off, reportEnvelope())).statusCode).toBe(404);
    await off.close();
    app = null;

    const target = await start();
    repository.failure = new Error("connection terminated");
    const response = await post(target, reportEnvelope());
    expect(response.statusCode).toBe(503);
    expect(received).toHaveLength(0);
  });
});
