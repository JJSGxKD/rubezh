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
import { runBucket, runEnvelope, runSubmission, RUN_REPORT_ID } from "./helpers/run-report.js";
import { runSummaryOf } from "../src/modules/diagnostics/diagnostics-summary.js";
import { submitRunReportSchema } from "../src/modules/diagnostics/dto/run-report.dto.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { launchFor } from "./helpers/init-data.js";
import { launchVerifiersFor } from "../src/platforms/platforms.module.js";
import { LaunchVerifiers } from "../src/platforms/ports/launch-verifier.js";

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
  async findRun(): Promise<null> {
    return null;
  }
  async list(): Promise<[]> {
    return [];
  }
  async find(reportId: string): Promise<ReportRecord | null> {
    return this.records.get(reportId) ?? null;
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
      ...AUTH_ENV,
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
        { provide: LaunchVerifiers, useValue: launchVerifiersFor(config) },
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
    expect((await post(target, reportEnvelope(REPORT_ID, { kind: "replay" }))).statusCode).toBe(400);
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

  it("принимает запись забега без права на стресс-тест и отдаёт слушателям её итог", async () => {
    const target = await start({ PLAYTEST_ENABLED: "false" });
    const response = await post(target, runEnvelope(RUN_REPORT_ID, { clientErrors: 2 }));
    expect(response.statusCode).toBe(200);
    expect((await post(target, runEnvelope())).json()).toEqual({ data: { reportId: RUN_REPORT_ID, duplicate: true } });
    await settle();

    expect(repository.records.get(RUN_REPORT_ID)).toMatchObject({
      kind: "run",
      schemaVersion: "rubezh.run.v1",
      summary: { outcome: "died", difficulty: "normal", survivalSec: 450, level: 21, clientErrors: 2, problems: ["client_errors"] },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("run");
  });

  it("отклоняет запись не по схеме: чужой reportId, таймлайн сверх часа, лог ввода не base64", async () => {
    const target = await start();
    const mismatched = runEnvelope("44444444-4444-4555-8666-777777777777");
    ((mismatched.payload as Record<string, Record<string, unknown>>).recording as Record<string, unknown>).reportId = RUN_REPORT_ID;
    expect((await post(target, mismatched)).statusCode).toBe(400);
    const tooLong = runEnvelope(RUN_REPORT_ID, { timeline: Array.from({ length: 721 }, (_, index) => runBucket(index)) });
    expect((await post(target, tooLong)).statusCode).toBe(400);
    expect((await post(target, runEnvelope(RUN_REPORT_ID, { inputData: "не base64!" }))).statusCode).toBe(400);
    expect(repository.records.size).toBe(0);
  });
});

describe("итог записи забега", () => {
  const summaryOf = (patch: Parameters<typeof runSubmission>[1]) => runSummaryOf(submitRunReportSchema.parse(runSubmission(RUN_REPORT_ID, patch)));

  it("ровный забег проблемным не считается", () => {
    expect(summaryOf({}).problems).toEqual([]);
  });

  it("рывки кадров, догоняние симуляции и ошибки клиента — разные причины", () => {
    expect(summaryOf({ over33Ratio: 0.08 }).problems).toEqual(["frame_drops"]);
    expect(summaryOf({ p95FrameMs: 41 }).problems).toEqual(["frame_drops"]);
    expect(summaryOf({ catchUpFrames: 60 }).problems).toEqual(["catch_up"]);
    // Упёрлись в потолок шагов хоть раз — игра замедлялась.
    expect(summaryOf({ maxSteps: 5 }).problems).toEqual(["catch_up"]);
    expect(summaryOf({ clientErrors: 1, over33Ratio: 0.2 }).problems).toEqual(["frame_drops", "client_errors"]);
  });

  it("короткий забег по кадрам не судит — загрузка и первая волна ничего не говорят об устройстве", () => {
    const short = summaryOf({ frames: 300, over33Ratio: 0.5, timeline: [runBucket(0, { frames: 300, catchUpFrames: 100, maxSteps: 5 })] });
    expect(short.problems).toEqual([]);
  });

  it("считает долю кадров с догонянием по всему таймлайну", () => {
    const summary = summaryOf({ catchUpFrames: 45 });
    expect(summary.catchUpRatio).toBeCloseTo(45 / 900, 4);
    expect(summary.maxSteps).toBe(1);
  });
});
