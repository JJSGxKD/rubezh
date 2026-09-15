import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyValueStorage } from "@bh/shared-types";
import { createDeferredSink } from "../src/state/analytics";
import { resetErrorReporting, shouldReportError } from "../src/state/shell";
import { TELEMETRY_MAX_QUEUED, createTelemetry, type Telemetry } from "../src/state/telemetry";

// Эмиттер событий (docs/22-analytics-and-metrics.md §3.2, docs/26-stage2-plan.md, WP8).

function memoryStorage(values: Record<string, string> = {}): KeyValueStorage & { values: Record<string, string> } {
  return {
    values,
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

interface Call {
  url: string;
  body: { events: { eventId: string; eventType: string; occurredAt: string; installId: string; platform: string; payload: unknown }[] };
  headers: Record<string, string>;
  keepalive: boolean;
}

describe("эмиттер событий", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let calls: Call[];
  let status: number | "offline";
  let clock: number;
  let telemetry: Telemetry;

  function create(launch: string | null = "query_id=AAE&hash=abc"): Telemetry {
    return createTelemetry(
      { baseUrl: "https://api.example/" },
      {
        storage,
        installId: () => "install-0001",
        sessionId: "session-0001",
        appVersion: "0.4.0",
        platform: "telegram",
        signedLaunchData: () => launch,
        now: () => clock,
        fetchImpl: async (url, init) => {
          calls.push({
            url,
            body: JSON.parse(String(init.body)) as Call["body"],
            headers: init.headers as Record<string, string>,
            keepalive: init.keepalive === true,
          });
          if (status === "offline") throw new TypeError("Failed to fetch");
          return new Response(null, { status });
        },
      },
    );
  }

  function queued(): number {
    return (JSON.parse(storage.values["bh.telemetry.v1.queue"] ?? "[]") as unknown[]).length;
  }

  beforeEach(() => {
    storage = memoryStorage();
    calls = [];
    status = 202;
    clock = Date.parse("2026-09-15T12:00:00Z");
    telemetry = create();
  });

  afterEach(() => {
    telemetry.stop();
  });

  it("собирает конверт и отправляет пачку с подписью запуска", async () => {
    telemetry.record("screen_viewed", { screen: "lobby", stub: false }, Date.parse("2026-09-15T11:59:58Z"));
    await telemetry.flush("timer");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example/api/v1/events");
    expect(calls[0]?.headers.authorization).toBe("tma query_id=AAE&hash=abc");
    expect(calls[0]?.body.events[0]).toMatchObject({
      eventType: "screen_viewed",
      occurredAt: "2026-09-15T11:59:58.000Z",
      installId: "install-0001",
      platform: "telegram",
      payload: { screen: "lobby", stub: false },
    });
    expect(queued()).toBe(0);
  });

  it("отправляет сам, когда накопилось на пачку, не дожидаясь таймера", async () => {
    for (let i = 0; i < 25; i++) telemetry.record("wave_reached", { wave: i, elapsedSec: i * 60 }, clock);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.events).toHaveLength(25);
  });

  it("без сети держит события в очереди и ждёт паузу, но появление сети отправляет сразу", async () => {
    status = "offline";
    telemetry.record("run_started", { seed: 1 }, clock);
    await telemetry.flush("timer");
    expect(queued()).toBe(1);

    status = 202;
    await telemetry.flush("timer");
    expect(calls).toHaveLength(1); // пауза после неудачи

    await telemetry.flush("online");
    expect(calls).toHaveLength(2);
    expect(queued()).toBe(0);
  });

  it("переживает перезапуск: очередь из хранилища уходит со следующим запуском", async () => {
    status = "offline";
    telemetry.record("run_finished", { seed: 3 }, clock);
    await telemetry.flush("timer");
    telemetry.stop();

    status = 202;
    telemetry = create();
    await telemetry.flush("launch");
    expect(calls.at(-1)?.body.events.map((event) => event.eventType)).toEqual(["run_finished"]);
    // Идентификатор события тот же: сервер отсечёт повтор, если первая отправка всё же дошла.
    expect(calls[0]?.body.events[0]?.eventId).toBe(calls.at(-1)?.body.events[0]?.eventId);
  });

  it("выключенный приёмник не долбят до следующего запуска, а отвергнутую пачку выбрасывают", async () => {
    status = 404;
    telemetry.record("run_started", { seed: 1 }, clock);
    await telemetry.flush("timer");
    await telemetry.flush("online");
    expect(calls).toHaveLength(1);
    expect(queued()).toBe(1);

    telemetry.stop();
    telemetry = create();
    status = 400;
    await telemetry.flush("launch");
    expect(queued()).toBe(0);
  });

  it("при сворачивании отправляет с keepalive и укладывает тело в 60 КБ", async () => {
    status = "offline";
    for (let i = 0; i < 150; i++) telemetry.record("client_error", { scope: "run", message: "y".repeat(500) }, clock);
    // Обычная отправка по размеру ещё в пути — сворачивание её не ждёт.
    calls = [];
    status = 202;
    await telemetry.flush("hidden");
    const hidden = calls.find((call) => call.keepalive);
    expect(hidden).toBeDefined();
    expect(hidden?.body.events.length).toBeGreaterThan(50);
    expect(JSON.stringify(hidden?.body).length).toBeLessThanOrEqual(60_000);
  });

  it("не даёт очереди расти без предела", () => {
    status = "offline";
    for (let i = 0; i < TELEMETRY_MAX_QUEUED + 50; i++) telemetry.record("wave_reached", { wave: i, elapsedSec: 0 }, clock);
    expect(queued()).toBe(TELEMETRY_MAX_QUEUED);
  });

  it("сбрасывает испорченную очередь, а не падает", () => {
    telemetry.stop();
    storage.values["bh.telemetry.v1.queue"] = "{битый json";
    telemetry = create();
    expect(storage.values["bh.telemetry.v1.queue"]).toBeUndefined();
  });
});

describe("буфер до загрузки эмиттера", () => {
  it("отдаёт накопленное по порядку и со временем события, а не подключения", () => {
    const deferred = createDeferredSink();
    deferred.sink("load_time", { phase: "shell_ready", ms: 900 });
    deferred.sink("app_first_open", {});
    const received: string[] = [];
    deferred.attach((event, _payload, atMs) => received.push(`${event}@${atMs > 0}`));
    deferred.sink("screen_viewed", { screen: "lobby", stub: false });
    expect(received).toEqual(["load_time@true", "app_first_open@true", "screen_viewed@true"]);
  });
});

describe("ошибки клиента", () => {
  beforeEach(() => resetErrorReporting());

  it("одну и ту же ошибку шлёт не чаще раза в минуту и не больше тридцати за запуск", () => {
    const now = 1_000_000;
    expect(shouldReportError("run", "контекст WebGL потерян", now)).toBe(true);
    expect(shouldReportError("run", "контекст WebGL потерян", now + 1_000)).toBe(false);
    expect(shouldReportError("run", "контекст WebGL потерян", now + 61_000)).toBe(true);
    for (let i = 0; i < 40; i++) shouldReportError("run", `ошибка ${i}`, now);
    expect(shouldReportError("run", "новая", now)).toBe(false);
  });
});
