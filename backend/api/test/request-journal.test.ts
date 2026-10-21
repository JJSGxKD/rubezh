import "reflect-metadata";
import { Controller, Get, Global, Logger, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { OUTBOUND_SINK, type OutboundRecord } from "../src/infra/outbound/outbound.js";
import { APP_OUTBOUND_SINK, OutboundModule } from "../src/infra/outbound/outbound.module.js";
import { REDIS } from "../src/infra/redis.js";
import { InboundCounter } from "../src/modules/request-journal/inbound-counter.js";
import {
  BUCKET_COUNT,
  INBOUND_PAUSE_MS,
  JOURNAL_KEEP_DAYS,
  LATENCY_BUCKETS_MS,
  NO_ROUTE,
  OUTBOUND_BUFFER_MAX,
  ROLLUP_GRACE_MS,
  bucketOf,
  isServiceRoute,
  minuteKey,
  outboundRow,
  quantileMs,
  statusClass,
} from "../src/modules/request-journal/journal-rules.js";
import { JournalRollup } from "../src/modules/request-journal/journal.rollup.js";
import { BufferedOutboundSink } from "../src/modules/request-journal/outbound-sink.js";
import type { InboundMinuteRow, RequestJournalRepository } from "../src/modules/request-journal/request-journal.repository.js";

// Журнал запросов — хранение (docs/35-stage4-plan.md Р92, tasks/T-0060):
// исходящие по вызову пачками, входящие сводкой по маршрутам за минуту, 7 суток.
// Здесь — правила, буфер, счётчик и перенос на подмене Redis и базы; живые
// Postgres и Redis — в request-journal.integration.test.ts.

const NOW = new Date("2026-10-12T13:06:30.000Z");
const MINUTE_1305 = new Date("2026-10-12T13:05:00.000Z");

describe("правила журнала", () => {
  it("корзина времени: граница входит в свою корзину, дольше всех — последняя", () => {
    expect(LATENCY_BUCKETS_MS).toEqual([25, 50, 100, 250, 500, 1000, 2500, 5000]);
    expect(BUCKET_COUNT).toBe(9);
    expect(bucketOf(10)).toBe(0);
    expect(bucketOf(25)).toBe(0);
    expect(bucketOf(26)).toBe(1);
    expect(bucketOf(5000)).toBe(7);
    expect(bucketOf(9000)).toBe(8);
  });

  it("корзина времени: ноль и отрицательное — первая, не исключение", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(-3)).toBe(0);
  });

  it("класс статуса", () => {
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(302)).toBe("3xx");
    expect(statusClass(429)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
  });

  it("медиана и 95-й перцентиль — верхняя граница корзины, где набралась доля", () => {
    const buckets = new Array<number>(BUCKET_COUNT).fill(0);
    buckets[1] = 90;
    buckets[5] = 10;
    expect(quantileMs(buckets, 0.5)).toBe(50);
    expect(quantileMs(buckets, 0.95)).toBe(1000);
    expect(quantileMs(buckets, 1)).toBe(1000);
  });

  it("перцентиль: пусто — null; одна корзина — её граница; «дольше» — её нижняя граница", () => {
    expect(quantileMs(new Array<number>(BUCKET_COUNT).fill(0), 0.5)).toBeNull();
    expect(quantileMs([], 0.5)).toBeNull();
    expect(quantileMs([0, 0, 4, 0, 0, 0, 0, 0, 0], 0.95)).toBe(100);
    // У последней корзины верхней границы нет: значение читается как «не меньше».
    expect(quantileMs([0, 0, 0, 0, 0, 0, 0, 0, 4], 0.5)).toBe(5000);
  });

  it("перцентиль: пустые корзины в начале не считаются, дробная доля не сдвигает корзину", () => {
    // 100 ответов, 7% из них в первой корзине: доля 0,07 должна дать ровно 7-й ответ.
    const buckets = [7, 93, 0, 0, 0, 0, 0, 0, 0];
    expect(quantileMs(buckets, 0.07)).toBe(25);
    expect(quantileMs(buckets, 0.08)).toBe(50);
    expect(quantileMs([0, 0, 0, 5, 0, 0, 0, 0, 0], 0.001)).toBe(250);
  });

  it("ключ минуты — по UTC, с нулями", () => {
    expect(minuteKey(new Date("2026-10-12T13:05:59Z"))).toBe("inbound:m:202610121305");
    expect(minuteKey(new Date("2026-01-02T03:04:05Z"))).toBe("inbound:m:202601020304");
    expect(minuteKey(new Date("2026-12-31T23:59:59.999Z"))).toBe("inbound:m:202612312359");
  });

  it("служебные маршруты — только health", () => {
    expect(isServiceRoute("/health")).toBe(true);
    expect(isServiceRoute("/health/ready")).toBe(true);
    expect(isServiceRoute("/api/v1/health")).toBe(false);
    expect(isServiceRoute("/healthy-living")).toBe(false);
    expect(isServiceRoute(NO_ROUTE)).toBe(false);
  });

  it("числа журнала", () => {
    expect(JOURNAL_KEEP_DAYS).toBe(7);
    expect(OUTBOUND_BUFFER_MAX).toBe(2000);
  });

  it("строка исходящего: длинные поля обрезаны под колонки, время округлено, NUL убран", () => {
    const at = new Date("2026-10-12T13:05:00Z");
    const row = outboundRow({
      service: "telegram.bot",
      method: "POST",
      host: "h".repeat(300),
      path: `/${"p".repeat(400)}\u0000`,
      status: 200,
      ok: true,
      durationMs: 12.6,
      via: "v".repeat(80),
      attempt: 1,
      error: "e".repeat(40),
      at,
    });
    expect(row.host).toHaveLength(128);
    expect(row.path).toHaveLength(256);
    expect(row.path).not.toContain("\u0000");
    expect(row.via).toHaveLength(40);
    expect(row.error).toHaveLength(16);
    expect(row.durationMs).toBe(13);
    expect(row.at).toBe(at);
  });
});

// --- подмены ----------------------------------------------------------------

type Batch = {
  hincrby(key: string, field: string, by: number): Batch;
  expire(key: string, seconds: number): Batch;
  hgetall(key: string): Batch;
  exec(): Promise<[Error | null, unknown][]>;
};

/** Redis в памяти: ровно те команды, которыми пользуется журнал. */
class FakeRedis {
  readonly hashes = new Map<string, Map<string, number>>();
  readonly strings = new Map<string, string>();
  readonly ttl = new Map<string, number>();
  down = false;
  /** сколько раз к Redis ходили (пачка — одно обращение) */
  roundTrips = 0;

  private touch(): void {
    this.roundTrips += 1;
    if (this.down) throw new Error("connection refused");
  }

  private batch(): Batch {
    const ops: (() => unknown)[] = [];
    const chain: Batch = {
      hincrby: (key, field, by) => {
        ops.push(() => {
          const hash = this.hashes.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + by);
          this.hashes.set(key, hash);
          return hash.get(field);
        });
        return chain;
      },
      expire: (key, seconds) => {
        ops.push(() => {
          this.ttl.set(key, seconds);
          return 1;
        });
        return chain;
      },
      hgetall: (key) => {
        ops.push(() => Object.fromEntries([...(this.hashes.get(key) ?? [])].map(([field, value]) => [field, String(value)])));
        return chain;
      },
      exec: async () => {
        this.touch();
        return ops.map((op) => [null, op()] as [Error | null, unknown]);
      },
    };
    return chain;
  }

  multi(): Batch {
    return this.batch();
  }

  pipeline(): Batch {
    return this.batch();
  }

  async del(...keys: string[]): Promise<number> {
    this.touch();
    let removed = 0;
    for (const key of keys) {
      if (this.hashes.delete(key) || this.strings.delete(key)) removed += 1;
    }
    return removed;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    this.touch();
    if (args.includes("NX") && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }

  async eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    this.touch();
    if (this.strings.get(key) !== token) return 0;
    this.strings.delete(key);
    return 1;
  }
}

function asRedis(fake: FakeRedis): Redis {
  return fake as unknown as Redis;
}

/** Хранилище журнала в памяти: что и какими пачками ему отдали. */
class FakeStore implements RequestJournalRepository {
  readonly outbound: OutboundRecord[][] = [];
  readonly inbound: InboundMinuteRow[][] = [];
  readonly outboundCleanups: { cutoff: Date; limit: number }[] = [];
  readonly inboundCleanups: { cutoff: Date; limit: number }[] = [];
  /** сколько ближайших записей в базу падает */
  failures = 0;
  /** сколько строк «удалила» каждая очередная пачка уборки */
  deletions: number[] = [];

  private maybeFail(): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("база недоступна");
    }
  }

  async insertOutboundCalls(records: readonly OutboundRecord[]): Promise<void> {
    this.maybeFail();
    this.outbound.push([...records]);
  }

  async addInboundMinutes(rows: readonly InboundMinuteRow[]): Promise<void> {
    this.maybeFail();
    this.inbound.push([...rows]);
  }

  async deleteOutboundBefore(cutoff: Date, limit: number): Promise<number> {
    this.outboundCleanups.push({ cutoff, limit });
    return this.deletions.shift() ?? 0;
  }

  async deleteInboundBefore(cutoff: Date, limit: number): Promise<number> {
    this.inboundCleanups.push({ cutoff, limit });
    return 0;
  }

  /** все перенесённые строки одним списком, по минуте и маршруту */
  rows(): InboundMinuteRow[] {
    return this.inbound
      .flat()
      .sort((a, b) => a.minute.getTime() - b.minute.getTime() || a.route.localeCompare(b.route) || a.statusClass.localeCompare(b.statusClass));
  }
}

function record(overrides: Partial<OutboundRecord> = {}): OutboundRecord {
  return {
    service: "telegram.bot",
    method: "POST",
    host: "api.telegram.org",
    path: "/bot***/sendMessage",
    status: 200,
    ok: true,
    durationMs: 120,
    via: "direct",
    attempt: 1,
    error: null,
    at: new Date("2026-10-12T13:05:00Z"),
    ...overrides,
  };
}

function fill(sink: BufferedOutboundSink, count: number): void {
  for (let index = 0; index < count; index += 1) sink.write(record({ durationMs: index }));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("буфер исходящих", () => {
  it("2001-я запись отброшена, счётчик отброшенных — 1", () => {
    const sink = new BufferedOutboundSink(new FakeStore());

    fill(sink, OUTBOUND_BUFFER_MAX + 1);

    expect(sink.size).toBe(OUTBOUND_BUFFER_MAX);
    expect(sink.dropped).toBe(1);
  });

  it("сброс отдаёт пачку целиком, по порядку, и очищает буфер", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);
    fill(sink, 3);

    expect(await sink.flush()).toBe(3);

    expect(store.outbound).toHaveLength(1);
    expect(store.outbound[0]?.map((item) => item.durationMs)).toEqual([0, 1, 2]);
    expect(sink.size).toBe(0);
  });

  it("пустой буфер в базу не ходит", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);

    expect(await sink.flush()).toBe(0);

    expect(store.outbound).toHaveLength(0);
  });

  it("после сброса записи снова принимаются, отброшенные остаются в счётчике", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);
    fill(sink, OUTBOUND_BUFFER_MAX + 5);
    await sink.flush();

    fill(sink, 2);

    expect(sink.size).toBe(2);
    expect(sink.dropped).toBe(5);
    expect(store.outbound[0]).toHaveLength(OUTBOUND_BUFFER_MAX);
  });

  it("запись не ждёт и не бросает: работает синхронно", () => {
    const sink = new BufferedOutboundSink(new FakeStore());
    expect(sink.write(record())).toBeUndefined();
  });

  it("предупреждение об отброшенных — не чаще раза в минуту", () => {
    let nowMs = 1_000_000;
    const sink = new BufferedOutboundSink(new FakeStore(), () => nowMs);
    fill(sink, OUTBOUND_BUFFER_MAX);

    sink.write(record());
    sink.write(record());
    nowMs += 30_000;
    sink.write(record());
    expect(warn).toHaveBeenCalledTimes(1);

    nowMs += 31_000;
    sink.write(record());
    expect(warn).toHaveBeenCalledTimes(2);
    expect(sink.dropped).toBe(4);
  });

  it("сбой базы не бросает наружу: пачка остаётся и уходит со следующим сбросом", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);
    fill(sink, 4);
    store.failures = 1;

    expect(await sink.flush()).toBe(0);
    expect(sink.size).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);

    sink.write(record({ durationMs: 99 }));
    expect(await sink.flush()).toBe(5);
    expect(sink.size).toBe(0);
    expect(store.outbound[0]?.map((item) => item.durationMs)).toEqual([0, 1, 2, 3, 99]);
  });

  it("пачка, которую база не принимает три сброса подряд, выбрасывается со счётом", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);
    fill(sink, 5);
    store.failures = 10;

    await sink.flush();
    await sink.flush();
    expect(sink.size).toBe(5);
    await sink.flush();

    expect(sink.size).toBe(0);
    expect(sink.dropped).toBe(5);
  });

  it("при возврате пачки лишнее сверх потолка отбрасывается", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);
    fill(sink, OUTBOUND_BUFFER_MAX);
    store.failures = 1;
    const flushing = sink.flush();
    // Пока пачка уходит, буфер набирает новое.
    fill(sink, 10);
    await flushing;

    expect(sink.size).toBe(OUTBOUND_BUFFER_MAX);
    expect(sink.dropped).toBe(10);
  });

  it("два сброса одновременно не отдают одну пачку дважды", async () => {
    const store = new FakeStore();
    const sink = new BufferedOutboundSink(store);
    fill(sink, 3);

    await Promise.all([sink.flush(), sink.flush()]);

    expect(store.outbound.flat()).toHaveLength(3);
  });
});

describe("счётчик входящих", () => {
  it("три ответа в минуту — одна строка: число и корзины времени", async () => {
    const redis = new FakeRedis();
    const store = new FakeStore();
    const counter = new InboundCounter(asRedis(redis));
    const at = new Date("2026-10-12T13:05:10Z");

    await counter.count("GET", "/api/v1/runs/:runId", 200, 20, at);
    await counter.count("GET", "/api/v1/runs/:runId", 204, 30, at);
    await counter.count("GET", "/api/v1/runs/:runId", 200, 9000, at);
    await new JournalRollup(asRedis(redis), store).rollInbound(NOW);

    expect(store.rows()).toEqual([
      { minute: MINUTE_1305, method: "GET", route: "/api/v1/runs/:runId", statusClass: "2xx", count: 3, buckets: [1, 1, 0, 0, 0, 0, 0, 0, 1] },
    ]);
  });

  it("ключ делят минута, метод, маршрут и класс статуса", async () => {
    const redis = new FakeRedis();
    const store = new FakeStore();
    const counter = new InboundCounter(asRedis(redis));
    const at = new Date("2026-10-12T13:05:10Z");

    await counter.count("GET", "/api/v1/runs/:runId", 200, 40, at);
    await counter.count("POST", "/api/v1/runs/:runId", 200, 40, at);
    await counter.count("GET", "/api/v1/runs/:runId", 404, 40, at);
    await counter.count("GET", "/api/v1/me", 200, 40, at);
    await counter.count("GET", "/api/v1/me", 200, 40, new Date("2026-10-12T13:04:59Z"));
    await new JournalRollup(asRedis(redis), store).rollInbound(NOW);

    const keys = store.rows().map((row) => `${row.minute.toISOString().slice(11, 16)} ${row.method} ${row.route} ${row.statusClass} ${String(row.count)}`);
    expect(keys.sort()).toEqual([
      "13:04 GET /api/v1/me 2xx 1",
      "13:05 GET /api/v1/me 2xx 1",
      "13:05 GET /api/v1/runs/:runId 2xx 1",
      "13:05 GET /api/v1/runs/:runId 4xx 1",
      "13:05 POST /api/v1/runs/:runId 2xx 1",
    ]);
  });

  it("срок жизни ключа минуты — два часа, и он продлевается каждой записью", async () => {
    const redis = new FakeRedis();
    const counter = new InboundCounter(asRedis(redis));

    await counter.count("GET", "/api/v1/me", 200, 10, new Date("2026-10-12T13:05:10Z"));

    expect(redis.ttl.get("inbound:m:202610121305")).toBe(7200);
  });

  it("счёт и корзина пишутся одной транзакцией: одно обращение к Redis", async () => {
    const redis = new FakeRedis();
    const counter = new InboundCounter(asRedis(redis));

    await counter.count("GET", "/api/v1/me", 200, 10, NOW);

    expect(redis.roundTrips).toBe(1);
  });

  it("маршрут с разделителем и очень длинный — не ломают перенос, длинный обрезан под колонку", async () => {
    const redis = new FakeRedis();
    const store = new FakeStore();
    const counter = new InboundCounter(asRedis(redis));
    const at = new Date("2026-10-12T13:05:10Z");

    await counter.count("GET", "/a|b|c", 200, 10, at);
    await counter.count("GET", `/${"x".repeat(300)}`, 200, 10, at);
    await new JournalRollup(asRedis(redis), store).rollInbound(NOW);

    const routes = store.rows().map((row) => row.route);
    expect(routes).toContain("/a|b|c");
    expect(routes.some((route) => route.length === 160)).toBe(true);
    expect(routes.every((route) => route.length <= 160)).toBe(true);
  });

  it("Redis недоступен: вызов не падает, пауза не гоняет команды, предупреждение — раз в минуту", async () => {
    const redis = new FakeRedis();
    redis.down = true;
    let nowMs = 5_000_000;
    const counter = new InboundCounter(asRedis(redis), () => nowMs);

    await expect(counter.count("GET", "/api/v1/me", 200, 10, NOW)).resolves.toBeUndefined();
    expect(redis.roundTrips).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // Пауза: Redis не дёргают, игрок и логи не страдают.
    await counter.count("GET", "/api/v1/me", 200, 10, NOW);
    expect(redis.roundTrips).toBe(1);

    nowMs += INBOUND_PAUSE_MS + 1;
    await counter.count("GET", "/api/v1/me", 200, 10, NOW);
    expect(redis.roundTrips).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    await counter.count("GET", "/api/v1/me", 200, 10, NOW);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("Redis вернулся: счёт идёт дальше", async () => {
    const redis = new FakeRedis();
    redis.down = true;
    let nowMs = 5_000_000;
    const counter = new InboundCounter(asRedis(redis), () => nowMs);
    await counter.count("GET", "/api/v1/me", 200, 10, NOW);

    redis.down = false;
    nowMs += INBOUND_PAUSE_MS + 1;
    await counter.count("GET", "/api/v1/me", 200, 10, NOW);

    expect(redis.hashes.size).toBe(1);
  });
});

describe("перенос сводки в базу", () => {
  const AT_1305 = new Date("2026-10-12T13:05:10Z");

  async function seeded(): Promise<{ redis: FakeRedis; store: FakeStore; rollup: JournalRollup; counter: InboundCounter }> {
    const redis = new FakeRedis();
    const store = new FakeStore();
    return { redis, store, rollup: new JournalRollup(asRedis(redis), store), counter: new InboundCounter(asRedis(redis)) };
  }

  it("переносит прошедшие минуты и удаляет их ключи, идущую минуту не трогает", async () => {
    const { redis, store, rollup, counter } = await seeded();
    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);
    await counter.count("GET", "/api/v1/me", 200, 10, new Date("2026-10-12T13:06:10Z"));

    const rolled = await rollup.rollInbound(NOW);

    expect(rolled).toBe(1);
    expect(store.rows().map((row) => row.minute.toISOString())).toEqual([MINUTE_1305.toISOString()]);
    expect(redis.hashes.has("inbound:m:202610121305")).toBe(false);
    expect(redis.hashes.has("inbound:m:202610121306")).toBe(true);
  });

  it("минуту переносят не сразу после её конца: запас на команды, которые ещё в пути", async () => {
    const { redis, store, rollup, counter } = await seeded();
    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);
    const endOfMinute = MINUTE_1305.getTime() + 60_000;

    expect(await rollup.rollInbound(new Date(endOfMinute + ROLLUP_GRACE_MS - 1))).toBe(0);
    expect(redis.hashes.has("inbound:m:202610121305")).toBe(true);

    expect(await rollup.rollInbound(new Date(endOfMinute + ROLLUP_GRACE_MS))).toBe(1);
    expect(store.rows()).toHaveLength(1);
  });

  it("повторный перенос той же минуты не задваивает", async () => {
    const { store, rollup, counter } = await seeded();
    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);

    await rollup.rollInbound(NOW);
    await rollup.rollInbound(NOW);

    expect(store.inbound).toHaveLength(1);
    expect(store.rows()[0]?.count).toBe(1);
  });

  it("запоздавшая запись в уже перенесённую минуту уходит в следующем проходе — база прибавляет", async () => {
    const { store, rollup, counter } = await seeded();
    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);
    await rollup.rollInbound(NOW);

    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);
    await rollup.rollInbound(new Date(NOW.getTime() + 60_000));

    expect(store.inbound).toHaveLength(2);
    expect(store.rows().map((row) => row.count)).toEqual([1, 1]);
  });

  it("база недоступна: ключ остаётся и переносится следующим проходом", async () => {
    const { redis, store, rollup, counter } = await seeded();
    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);
    store.failures = 1;

    expect(await rollup.rollInbound(NOW)).toBe(0);
    expect(redis.hashes.has("inbound:m:202610121305")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    expect(await rollup.rollInbound(NOW)).toBe(1);
    expect(store.rows()[0]?.count).toBe(1);
    expect(redis.hashes.has("inbound:m:202610121305")).toBe(false);
  });

  it("битые поля пропускаются, остальные переносятся, ключ убирается", async () => {
    const { redis, store, rollup, counter } = await seeded();
    await counter.count("GET", "/api/v1/me", 200, 10, AT_1305);
    const hash = redis.hashes.get("inbound:m:202610121305");
    hash?.set("мусор", 5);
    hash?.set("GET|9xx|n|/x", 5);
    hash?.set("GET|2xx|99|/x", 5);
    hash?.set("GET|2xx|n|/neg", -4);

    await rollup.rollInbound(NOW);

    expect(store.rows().map((row) => row.route)).toEqual(["/api/v1/me"]);
    expect(redis.hashes.has("inbound:m:202610121305")).toBe(false);
  });

  it("пустой Redis — ничего не переносит и в базу не ходит", async () => {
    const { store, rollup } = await seeded();

    expect(await rollup.rollInbound(NOW)).toBe(0);
    expect(store.inbound).toHaveLength(0);
  });

  it("за один проход Redis опрашивается одной пачкой", async () => {
    const { redis, rollup } = await seeded();

    await rollup.rollInbound(NOW);

    expect(redis.roundTrips).toBe(1);
  });
});

describe("уборка и проход под локом", () => {
  async function setup(): Promise<{ redis: FakeRedis; store: FakeStore; rollup: JournalRollup }> {
    const redis = new FakeRedis();
    const store = new FakeStore();
    return { redis, store, rollup: new JournalRollup(asRedis(redis), store) };
  }

  it("уборка: обе таблицы, граница — семь суток, пачками по 5000 до неполной", async () => {
    const { store, rollup } = await setup();
    store.deletions = [5000, 5000, 120];

    const cleaned = await rollup.cleanup(NOW);

    expect(cleaned.outbound).toBe(10_120);
    expect(store.outboundCleanups).toHaveLength(3);
    expect(store.outboundCleanups[0]).toEqual({ cutoff: new Date("2026-10-05T13:06:30.000Z"), limit: 5000 });
    expect(store.inboundCleanups).toHaveLength(1);
    expect(store.inboundCleanups[0]?.cutoff).toEqual(new Date("2026-10-05T13:06:30.000Z"));
  });

  it("проход: переносит сводку и убирает старое; уборка — раз в сутки", async () => {
    const { store, rollup } = await setup();

    const first = await rollup.tick(NOW);
    const second = await rollup.tick(new Date(NOW.getTime() + 60_000));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(store.outboundCleanups).toHaveLength(1);
    expect(store.inboundCleanups).toHaveLength(1);
  });

  it("проход: сутки спустя уборка идёт снова", async () => {
    const { redis, store, rollup } = await setup();
    await rollup.tick(NOW);
    // Метка суток в настоящем Redis сама истекает; здесь её снимает «время».
    for (const key of [...redis.strings.keys()]) if (key !== "request-journal:lock") redis.strings.delete(key);

    await rollup.tick(new Date(NOW.getTime() + 24 * 3600_000));

    expect(store.outboundCleanups).toHaveLength(2);
  });

  it("проход: лок отпущен после работы, чужой лок — проход не запускается", async () => {
    const { redis, store, rollup } = await setup();

    await rollup.tick(NOW);
    expect(redis.strings.has("request-journal:lock")).toBe(false);

    redis.strings.set("request-journal:lock", "чужая реплика");
    expect(await rollup.tick(NOW)).toBeNull();
    expect(redis.strings.get("request-journal:lock")).toBe("чужая реплика");
    expect(store.outboundCleanups).toHaveLength(1);
  });

  it("проход: Redis недоступен — null, без исключения", async () => {
    const { redis, rollup } = await setup();
    redis.down = true;

    await expect(rollup.tick(NOW)).resolves.toBeNull();
  });

  it("проход: сбой уборки не мешает переносу и снимает метку суток — уборку повторят", async () => {
    const { redis, store, rollup } = await setup();
    const counter = new InboundCounter(asRedis(redis));
    await counter.count("GET", "/api/v1/me", 200, 10, new Date("2026-10-12T13:05:10Z"));
    vi.spyOn(store, "deleteOutboundBefore").mockRejectedValueOnce(new Error("таймаут"));

    await rollup.tick(NOW);

    expect(store.rows()).toHaveLength(1);
    await rollup.tick(new Date(NOW.getTime() + 60_000));
    expect(store.inboundCleanups).toHaveLength(1);
  });
});

// --- хук входящих на настоящем Fastify -----------------------------------------

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

@Controller("ping")
class PingController {
  @Get(":id")
  ping(@Param("id") id: string): { id: string } {
    return { id };
  }
}

describe("хук входящих запросов", () => {
  async function start(redis: FakeRedis): Promise<Awaited<ReturnType<typeof createHttpApp>>> {
    @Module({
      controllers: [HealthStubController, PingController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "development" }) },
        { provide: REDIS, useValue: asRedis(redis) },
        InboundCounter,
      ],
    })
    class TestModule {}
    const app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  /** строки сводки по ключу «метод маршрут класс» — минуты не важны, прогон может пересечь границу минуты */
  async function summary(source: FakeRedis): Promise<Record<string, number>> {
    // На копии: перенос удаляет ключи, а опрос по `waitFor` повторяется.
    const redis = new FakeRedis();
    for (const [key, hash] of source.hashes) redis.hashes.set(key, new Map(hash));
    const store = new FakeStore();
    await new JournalRollup(asRedis(redis), store).rollInbound(new Date(Date.now() + 120_000));
    const result: Record<string, number> = {};
    for (const row of store.rows()) {
      const key = `${row.method} ${row.route} ${row.statusClass}`;
      result[key] = (result[key] ?? 0) + row.count;
    }
    return result;
  }

  it("считает по шаблону маршрута, а не по адресу; health и query не попадают", async () => {
    const redis = new FakeRedis();
    const app = await start(redis);
    try {
      await app.inject({ method: "GET", url: "/health" });
      await app.inject({ method: "GET", url: "/health/ready" });
      await app.inject({ method: "GET", url: "/api/v1/ping/abc" });
      await app.inject({ method: "GET", url: "/api/v1/ping/xyz?token=секрет" });
      await app.inject({ method: "GET", url: "/nowhere/42" });
      await vi.waitFor(async () => {
        expect(await summary(redis)).toEqual({
          "GET /api/v1/ping/:id 2xx": 2,
          [`GET ${NO_ROUTE} 4xx`]: 1,
        });
      });
    } finally {
      await app.close();
    }
  });

  it("Redis лёг: ответ игроку не меняется", async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const app = await start(redis);
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/ping/abc" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: "abc" });
    } finally {
      await app.close();
    }
  });
});

// --- подключение приёмника ---------------------------------------------------------

describe("приёмник исходящих в приложении", () => {
  it("приёмник из модуля журнала подменяет пустой", async () => {
    const sink = { write: vi.fn() };
    @Global()
    @Module({ providers: [{ provide: APP_OUTBOUND_SINK, useValue: sink }], exports: [APP_OUTBOUND_SINK] })
    class JournalStub {}
    @Module({ imports: [OutboundModule, JournalStub] })
    class Root {}
    const context = await NestFactory.createApplicationContext(Root, { logger: false });
    try {
      expect(context.get(OUTBOUND_SINK)).toBe(sink);
    } finally {
      await context.close();
    }
  });
});
