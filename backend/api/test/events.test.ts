import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { EventsController } from "../src/modules/events/events.controller.js";
import type { EventRow } from "../src/modules/events/events.repository.js";
import { EventsService } from "../src/modules/events/events.service.js";
import { EVENTS_SINK, type EventsSink } from "../src/modules/events/events.sink.js";
import { UnavailableError } from "../src/common/domain-error.js";
import { IngestGuard } from "../src/modules/ingest/ingest.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { launchFor } from "./helpers/init-data.js";

// Приёмник событий (docs/22-analytics-and-metrics.md §3.2, docs/28-diagnostics.md §5.3).

const TOKEN = "123456:TEST-events";
const ORIGIN = "https://rubezh.example";

class MemorySink implements EventsSink {
  readonly rows: EventRow[] = [];
  failure: Error | null = null;
  async write(rows: readonly EventRow[]): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.rows.push(...rows);
  }
}

/** Redis, которого нет: лимитер уходит в память — это тоже проверяется. */
const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

function event(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    eventType: "run_started",
    schemaVersion: 1,
    occurredAt: "2026-09-15T10:00:00.000Z",
    installId: "0f6f1f5e-1111-4222-8333-444455556666",
    sessionId: "5a1d2c3b-aaaa-4bbb-8ccc-dddddddddddd",
    platform: "telegram",
    appVersion: "0.4.0",
    payload: { seed: 7, weapon: "spark", map: "meadow", difficulty: "normal", screenMode: "fullscreen", orientation: "portrait", devMode: false },
    ...patch,
  };
}

describe("приёмник событий", () => {
  let app: NestFastifyApplication | null = null;
  let sink: MemorySink;

  async function start(env: Record<string, string> = {}): Promise<NestFastifyApplication> {
    sink = new MemorySink();
    const config = loadAppConfig({
      NODE_ENV: "test",
      EVENTS_INGEST_ENABLED: "true",
      DATABASE_URL: "postgresql://unused",
      TELEGRAM_BOT_TOKEN: TOKEN,
      ALLOWED_ORIGINS: ORIGIN,
      ...env,
    });
    @Module({
      controllers: [EventsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: EVENTS_SINK, useValue: sink },
        RateLimiter,
        IngestGuard,
        EventsService,
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
    return target.inject({ method: "POST", url: "/api/v1/events", headers: { origin: ORIGIN, ...headers }, payload: body as object });
  }

  it("принимает пачку с ответом 202 и не выбрасывает её из-за одного битого события", async () => {
    const target = await start();
    const response = await post(target, {
      events: [
        event(),
        event({ eventType: "run_ended" }),
        event({ schemaVersion: 2 }),
        event({ payload: { seed: "не число" } }),
        event({ eventId: "не uuid" }),
        event({ eventType: "client_error", payload: { scope: "run", message: "контекст потерян", extra: 1 } }),
      ],
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { accepted: 2, rejected: 4, rejectedBy: { unknown_type: 1, unknown_version: 1, payload: 1, envelope: 1 } },
    });
    expect(sink.rows.map((row) => row.eventType)).toEqual(["run_started", "client_error"]);
    // Незнакомое поле нового клиента не выбрасывает событие.
    expect(sink.rows[1]?.payload).toMatchObject({ extra: 1 });
  });

  it("берёт Telegram ID только из проверенной подписи, а поддельную принимает без него", async () => {
    const target = await start();
    await post(target, { events: [event()] }, { authorization: `tma ${launchFor(777000111, TOKEN)}` });
    await post(target, { events: [event()] }, { authorization: `tma ${launchFor(777000111, "999:чужой")}` });
    await post(target, { events: [event({ platformUserId: "42" })] });
    expect(sink.rows.map((row) => row.platformUserId)).toEqual(["777000111", null, null]);
  });

  it("выключенный приёмник отвечает 404", async () => {
    const target = await start({ EVENTS_INGEST_ENABLED: "false" });
    const response = await post(target, { events: [event()] });
    expect(response.statusCode).toBe(404);
    expect(sink.rows).toHaveLength(0);
  });

  it("не принимает запрос не с домена игры", async () => {
    const target = await start();
    expect((await post(target, { events: [event()] }, { origin: "https://evil.example" })).statusCode).toBe(403);
    const noOrigin = await target.inject({ method: "POST", url: "/api/v1/events", payload: { events: [event()] } });
    expect(noOrigin.statusCode).toBe(403);
  });

  it("отвечает 413 на тело сверх лимита приёмника событий", async () => {
    const target = await start();
    const response = await post(target, { events: [event({ payload: { padding: "x".repeat(300 * 1024) } })] });
    expect(response.statusCode).toBe(413);
  });

  it("считает лимит установки в событиях: пачки по сто быстро упираются в него", async () => {
    const target = await start();
    const batch = (): unknown => ({ events: Array.from({ length: 100 }, () => event()) });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post(target, batch())).statusCode);
    expect(statuses.slice(0, 6)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(statuses[6]).toBe(429);
  });

  it("отвечает 503, когда пачку некуда записать, — клиент оставит её у себя", async () => {
    const target = await start();
    sink.failure = new UnavailableError("Приём событий временно недоступен");
    const response = await post(target, { events: [event()] });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "store_unavailable" } });
  });

  it("не пускает пачку больше сотни событий и пустую", async () => {
    const target = await start();
    expect((await post(target, { events: Array.from({ length: 101 }, () => event()) })).statusCode).toBe(400);
    expect((await post(target, { events: [] })).statusCode).toBe(400);
  });
});
