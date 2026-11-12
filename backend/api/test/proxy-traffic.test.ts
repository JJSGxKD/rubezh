import "reflect-metadata";
import { createServer, type IncomingHttpHeaders, type Http2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeQueryStatsRequest, grpcFrame, grpcUnframe, STATS_SERVICE_PATH } from "@bh/proxy-kit";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminProxyTrafficController } from "../src/modules/admin/admin-proxy-traffic.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { SUBSCRIPTION_REPOSITORY, type SubscriptionRepository, type SubscriptionSnapshot } from "../src/modules/proxies/subscription/subscription.repository.js";
import { TrafficCollector } from "../src/modules/proxies/subscription/traffic/traffic.collector.js";
import { TRAFFIC_REPOSITORY, type TrafficRepository, type TrafficRow, type TrafficTotal } from "../src/modules/proxies/subscription/traffic/traffic.repository.js";
import { TrafficService } from "../src/modules/proxies/subscription/traffic/traffic.service.js";
import {
  CLEANUP_MS,
  COLLECT_MS,
  PENDING_MAX,
  PERIOD_HOURS,
  STATS_TIMEOUT_MS,
  TRAFFIC_RETENTION_DAYS,
} from "../src/modules/proxies/subscription/traffic/traffic-rules.js";
import { Http2StatsSource, XrayStatsUnavailableError, type StatEntry, type StatsSource } from "../src/modules/proxies/subscription/traffic/xray-stats.client.js";
import { assembleConfig } from "../src/modules/proxies/subscription/xray-config-assembly.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryConfigWriter, MemorySubscriptionRepository } from "./helpers/memory-subscription.js";

/**
 * Учёт трафика узлов Xray (docs/35-stage4-plan.md Р192, tasks/T-0386): сборщик
 * читает счётчики ядра со сбросом раз в минуту и прибавляет их к часовым
 * корзинам; отчёт соединяет корзины с живыми подписками. Xray, база и часы —
 * подмены; клиент gRPC проверяется на настоящем `node:http2` в локальном
 * сервере, остальное — в памяти.
 */

const NOW = new Date("2026-11-07T14:25:00.000Z");
const HOUR = new Date("2026-11-07T14:00:00.000Z");
const HOUR_MS = 3_600_000;
const KEY1 = "0123456789abcdef";
const KEY2 = "fedcba9876543210";
const KEY3 = "aaaaaaaaaaaaaaaa";
const SECOND = "b2b2b2b2b2b2";
const ACTOR: AccountRef = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "1" };

const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const hours = (count: number, from: Date = HOUR): Date => new Date(from.getTime() + count * HOUR_MS);

const stat = (group: string, key: string, direction: "uplink" | "downlink", value: number | bigint): StatEntry => ({ name: `outbound>>>out-${group}-${key}>>>traffic>>>${direction}`, value: BigInt(value) });
const up = (group: string, key: string, value: number | bigint): StatEntry => stat(group, key, "uplink", value);
const down = (group: string, key: string, value: number | bigint): StatEntry => stat(group, key, "downlink", value);

/** Подмена Xray: отвечает по очереди; ошибка в очереди — Xray не отвечает. */
function sourceOf(...answers: (StatEntry[] | Error)[]) {
  const query = vi.fn(async (_reset: true): Promise<StatEntry[]> => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  });
  const source: StatsSource = { query };
  return { source, query, push: (...more: (StatEntry[] | Error)[]) => void answers.push(...more) };
}

const rowKey = (row: Pick<TrafficRow, "hour" | "subscriptionKey" | "nodeKey">): string => `${row.hour.toISOString()}|${row.subscriptionKey}|${row.nodeKey}`;

/** Часовые корзины в памяти: `add` прибавляет, как `ON CONFLICT … DO UPDATE SET x = x + EXCLUDED.x`. */
class MemoryTraffic implements TrafficRepository {
  rows = new Map<string, TrafficRow>();
  /** что принимал каждый удачный `add` */
  adds: TrafficRow[][] = [];
  /** сколько ближайших записей упадут */
  failAdds = 0;
  deleted: Date[] = [];
  failDelete = false;

  async add(rows: readonly TrafficRow[]): Promise<void> {
    if (this.failAdds > 0) {
      this.failAdds -= 1;
      throw new Error("база недоступна");
    }
    this.adds.push(rows.map((row) => ({ ...row })));
    for (const row of rows) {
      const found = this.rows.get(rowKey(row));
      this.rows.set(rowKey(row), found === undefined ? { ...row } : { ...row, upBytes: found.upBytes + row.upBytes, downBytes: found.downBytes + row.downBytes });
    }
  }

  async report(fromHour: Date): Promise<TrafficTotal[]> {
    const totals = new Map<string, TrafficTotal & { lastHour: number }>();
    for (const row of this.rows.values()) {
      if (row.hour.getTime() < fromHour.getTime()) continue;
      const key = `${row.subscriptionKey}|${row.nodeKey}`;
      const found = totals.get(key);
      const lastHour = Math.max(found?.lastHour ?? 0, row.hour.getTime());
      totals.set(key, {
        subscriptionKey: row.subscriptionKey,
        nodeKey: row.nodeKey,
        nodeName: found === undefined || row.hour.getTime() >= found.lastHour ? row.nodeName : found.nodeName,
        upBytes: (found?.upBytes ?? 0n) + row.upBytes,
        downBytes: (found?.downBytes ?? 0n) + row.downBytes,
        lastHour,
      });
    }
    return [...totals.values()].map(({ lastHour: _last, ...total }) => total);
  }

  async deleteBefore(hour: Date): Promise<number> {
    this.deleted.push(hour);
    if (this.failDelete) throw new Error("база недоступна");
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.hour.getTime() < hour.getTime()) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** строки по порядку подписки и узла: порядок записи в тестах не важен */
  list(): TrafficRow[] {
    return [...this.rows.values()].sort((a, b) => a.hour.getTime() - b.hour.getTime() || a.subscriptionKey.localeCompare(b.subscriptionKey) || a.nodeKey.localeCompare(b.nodeKey));
  }
}

const snapshot = (key: string, name: string, nodes: readonly [string, string][]): SubscriptionSnapshot => ({
  subscription: {
    key,
    name,
    urlIv: new Uint8Array(),
    urlTag: new Uint8Array(),
    urlCt: new Uint8Array(),
    urlKeyId: "k",
    urlHint: "хост …abcd",
    enabled: true,
    countries: [],
    lastRefreshAt: null,
    lastRefreshOk: null,
    lastRefreshNote: null,
    providerIntervalHours: null,
    trafficUsedBytes: null,
    trafficTotalBytes: null,
    expiresAt: null,
    updatedBy: ACTOR.accountId,
    updatedAt: NOW,
    createdAt: NOW,
  },
  nodes: nodes.map(([nodeKey, nodeName], slot) => ({
    subscriptionKey: key,
    nodeKey,
    slot,
    protocol: "vless",
    name: nodeName,
    country: null,
    host: "n.example.org",
    state: "healthy" as const,
    failures: 0,
    latencyMs: 40,
    lastProbeAt: NOW,
    nextProbeAt: NOW,
  })),
});

const SUBSCRIPTIONS: SubscriptionSnapshot[] = [
  snapshot("main", "Основная", [
    [KEY1, "Берлин"],
    [KEY2, "Амстердам"],
  ]),
  snapshot(SECOND, "Резервная", [[KEY1, "Берлин"]]),
];

interface Rig {
  repository: MemoryTraffic;
  subscriptions: { list: ReturnType<typeof vi.fn<() => Promise<SubscriptionSnapshot[]>>> };
  source: ReturnType<typeof sourceOf>;
  collector: TrafficCollector;
  /** JSON-строки предупреждений журнала сборщика */
  warnings: () => Record<string, unknown>[];
}

let warn: { mock: { calls: unknown[][] } };

function rig(options: { answers?: (StatEntry[] | Error)[]; subscriptions?: SubscriptionSnapshot[]; autostart?: boolean } = {}): Rig {
  const repository = new MemoryTraffic();
  const source = sourceOf(...(options.answers ?? []));
  const subscriptions = { list: vi.fn(async () => options.subscriptions ?? SUBSCRIPTIONS) };
  const collector = new TrafficCollector({ source: source.source, repository, subscriptions, autostart: options.autostart ?? false });
  return {
    repository,
    subscriptions,
    source,
    collector,
    warnings: () => warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>).filter((line) => line.module === "proxy-traffic"),
  };
}

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("правила учёта", () => {
  it("константы из спецификации: 35 суток, минута, час, 10 000 строк, 3 секунды, окна 24/168/720 часов", () => {
    expect(TRAFFIC_RETENTION_DAYS).toBe(35);
    expect(COLLECT_MS).toBe(60_000);
    expect(CLEANUP_MS).toBe(3_600_000);
    expect(PENDING_MAX).toBe(10_000);
    expect(STATS_TIMEOUT_MS).toBe(3_000);
    expect(PERIOD_HOURS).toEqual({ day: 24, week: 168, month: 720 });
  });
});

describe("сборщик: чтение счётчиков", () => {
  it("читает со сбросом; байты вверх и вниз — одной строкой узла за час чтения, название из узлов подписки", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100), down("main", KEY1, 2_000), up("main", KEY2, 5), down(SECOND, KEY1, 70)]] });

    await r.collector.collect(NOW);

    expect(r.source.query).toHaveBeenCalledWith(true);
    expect(r.repository.list()).toEqual([
      { hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 100n, downBytes: 2_000n },
      { hour: HOUR, subscriptionKey: "main", nodeKey: KEY2, nodeName: "Амстердам", upBytes: 5n, downBytes: 0n },
      { hour: HOUR, subscriptionKey: SECOND, nodeKey: KEY1, nodeName: "Берлин", upBytes: 0n, downBytes: 70n },
    ]);
  });

  it("служебные выходы (block, api, с суффиксом) и нулевые счётчики в базу не идут; узла нет в подписках — название равно ключу узла", async () => {
    const r = rig({
      answers: [
        [
          { name: "outbound>>>block>>>traffic>>>uplink", value: 999n },
          { name: "outbound>>>api>>>traffic>>>downlink", value: 999n },
          { name: `outbound>>>out-main-${KEY1}-dial>>>traffic>>>uplink`, value: 999n },
          { name: "inbound>>>in-0>>>traffic>>>uplink", value: 999n },
          up("main", KEY2, 0),
          down("main", KEY2, 0),
          up("main", KEY3, 9),
        ],
      ],
    });

    await r.collector.collect(NOW);

    expect(r.repository.list()).toEqual([{ hour: HOUR, subscriptionKey: "main", nodeKey: KEY3, nodeName: KEY3, upBytes: 9n, downBytes: 0n }]);
  });

  it("название длиннее 80 знаков обрезается под колонку", async () => {
    const long = snapshot("main", "Основная", [[KEY1, "я".repeat(120)]]);
    const r = rig({ answers: [[up("main", KEY1, 1)]], subscriptions: [long] });

    await r.collector.collect(NOW);

    expect(r.repository.list()[0]?.nodeName).toBe("я".repeat(80));
  });

  it("ничего не прошло через узлы — в базу ничего не пишется", async () => {
    const r = rig({ answers: [[]] });
    await r.collector.collect(NOW);
    expect(r.repository.adds).toEqual([]);
  });

  it("два чтения в одном часе складываются", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100), down("main", KEY1, 10)], [up("main", KEY1, 50), down("main", KEY1, 5)]] });

    await r.collector.collect(at(0));
    await r.collector.collect(at(30));

    expect(r.repository.list()).toEqual([{ hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 150n, downBytes: 15n }]);
  });

  it("чтение после смены часа идёт в новый час, а не в прежний", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100)], [up("main", KEY1, 7)]] });

    await r.collector.collect(new Date("2026-11-07T14:59:30.000Z"));
    await r.collector.collect(new Date("2026-11-07T15:00:30.000Z"));

    expect(r.repository.list().map((row) => [row.hour.toISOString(), row.upBytes])).toEqual([
      ["2026-11-07T14:00:00.000Z", 100n],
      ["2026-11-07T15:00:00.000Z", 7n],
    ]);
  });

  it("байты больше 2^53 не теряют точности в строке", async () => {
    const big = 9_007_199_254_740_993n;
    const r = rig({ answers: [[up("main", KEY1, big)]] });
    await r.collector.collect(NOW);
    expect(r.repository.list()[0]?.upBytes).toBe(big);
  });

  it("lastCollectedAt — время успешного чтения; сбой Xray его не двигает", async () => {
    const r = rig({ answers: [[up("main", KEY1, 1)], new Error("нет ответа")] });
    expect(r.collector.lastCollectedAt).toBeNull();

    await r.collector.collect(at(0));
    expect(r.collector.lastCollectedAt).toEqual(at(0));

    await r.collector.collect(at(1));
    expect(r.collector.lastCollectedAt).toEqual(at(0));
  });

  it("список подписок не прочитался — Xray не опрашивается: сброс счётчиков потерял бы данные", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100)]] });
    r.subscriptions.list.mockRejectedValueOnce(new Error("база недоступна"));

    await r.collector.collect(at(0));
    expect(r.source.query).not.toHaveBeenCalled();

    await r.collector.collect(at(1));
    expect(r.repository.list()[0]?.upBytes).toBe(100n);
  });

  it("flush читает так же, как collect, и ошибок не бросает", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100)], new Error("нет ответа")] });

    await r.collector.flush();
    expect(r.repository.list()).toHaveLength(1);

    await expect(r.collector.flush()).resolves.toBeUndefined();
  });

  it("параллельные collect и flush не пишут отложенное дважды", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100)], [], []] });
    r.repository.failAdds = 1;
    await r.collector.collect(at(0));
    expect(r.repository.list()).toEqual([]);

    await Promise.all([r.collector.collect(at(1)), r.collector.flush()]);

    expect(r.repository.list()[0]?.upBytes).toBe(100n);
  });
});

describe("сборщик: сбои", () => {
  it("ошибка записи — следующее чтение пишет сумму обоих", async () => {
    const r = rig({ answers: [[up("main", KEY1, 100), down("main", KEY1, 1)], [up("main", KEY1, 40), up("main", KEY2, 3)]] });
    r.repository.failAdds = 1;

    await r.collector.collect(at(0));
    expect(r.repository.list()).toEqual([]);

    await r.collector.collect(at(1));
    expect(r.repository.list()).toEqual([
      { hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 140n, downBytes: 1n },
      { hour: HOUR, subscriptionKey: "main", nodeKey: KEY2, nodeName: "Амстердам", upBytes: 3n, downBytes: 0n },
    ]);
  });

  it("два сбоя подряд — отложенное копится и уходит за один раз; названием остаётся последнее", async () => {
    const renamed = [snapshot("main", "Основная", [[KEY1, "Берлин-2"]])];
    const r = rig({ answers: [[up("main", KEY1, 10)], [up("main", KEY1, 20)], [up("main", KEY1, 30)]] });
    r.repository.failAdds = 2;

    await r.collector.collect(at(0));
    await r.collector.collect(at(1));
    r.subscriptions.list.mockResolvedValue(renamed);
    await r.collector.collect(at(2));

    expect(r.repository.adds).toHaveLength(1);
    expect(r.repository.list()).toEqual([{ hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин-2", upBytes: 60n, downBytes: 0n }]);
  });

  it("переполнение отложенных: старые строки отброшены, в логе одна строка", async () => {
    const many = (start: number, count: number): StatEntry[] => Array.from({ length: count }, (_, index) => up("main", (start + index).toString(16).padStart(16, "0"), 1));
    const r = rig({ answers: [many(0, 6_000), many(10_000, 6_000), []] });
    r.repository.failAdds = 2;

    await r.collector.collect(at(0)); // час 14:00
    await r.collector.collect(at(40)); // час 15:00
    await r.collector.collect(at(41));

    const written = r.repository.adds.flat();
    expect(written).toHaveLength(PENDING_MAX);
    expect(written.filter((row) => row.hour.getTime() === HOUR.getTime())).toHaveLength(4_000);
    expect(written.filter((row) => row.hour.getTime() === hours(1).getTime())).toHaveLength(6_000);
    const dropped = r.warnings().filter((line) => line.event === "pending_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ module: "proxy-traffic", dropped: 2_000 });
  });

  it("Xray не отвечает: ничего не записано, в лог не чаще раза в 10 минут, без адреса и текста ошибки", async () => {
    const failing = new XrayStatsUnavailableError();
    const r = rig({ answers: [failing, failing, failing, failing] });

    await r.collector.collect(at(0));
    await r.collector.collect(at(1));
    await r.collector.collect(at(9));
    expect(r.warnings().filter((line) => line.event === "stats_unavailable")).toHaveLength(1);

    await r.collector.collect(at(10));
    const lines = r.warnings().filter((line) => line.event === "stats_unavailable");
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toMatch(/10799|xray:|http/);
    expect(r.repository.adds).toEqual([]);
  });

  it("таймер жив после сбоя Xray: следующее чтение проходит", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const r = rig({ answers: [new XrayStatsUnavailableError(), [up("main", KEY1, 5)]], autostart: true });

    r.collector.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(COLLECT_MS);
    expect(r.source.query).toHaveBeenCalledTimes(1);
    expect(r.repository.list()).toEqual([]);

    await vi.advanceTimersByTimeAsync(COLLECT_MS);
    expect(r.source.query).toHaveBeenCalledTimes(2);
    expect(r.repository.list()[0]?.upBytes).toBe(5n);

    r.collector.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5 * COLLECT_MS);
    expect(r.source.query).toHaveBeenCalledTimes(2);
  });

  it("без базы (autostart: false) таймер не запускается", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const r = rig({ autostart: false });

    r.collector.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5 * COLLECT_MS);

    expect(r.source.query).not.toHaveBeenCalled();
  });

  it("ошибка записи пишется в лог не чаще раза в 10 минут, без текста ошибки базы", async () => {
    const r = rig({ answers: [[up("main", KEY1, 1)], [up("main", KEY1, 1)], [up("main", KEY1, 1)]] });
    r.repository.failAdds = 3;

    await r.collector.collect(at(0));
    await r.collector.collect(at(1));
    await r.collector.collect(at(2));

    const lines = r.warnings().filter((line) => line.event === "write_failed");
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("база недоступна");
  });
});

describe("сборщик: срок хранения", () => {
  it("раз в час удаляет корзины старше 35 суток — по границе часа", async () => {
    const r = rig({ answers: [[], [], []] });

    await r.collector.collect(at(0));
    expect(r.repository.deleted).toEqual([new Date("2026-10-03T14:00:00.000Z")]);

    await r.collector.collect(at(1));
    expect(r.repository.deleted).toHaveLength(1);

    await r.collector.collect(at(61));
    expect(r.repository.deleted).toEqual([new Date("2026-10-03T14:00:00.000Z"), new Date("2026-10-03T15:00:00.000Z")]);
  });

  it("очистка идёт и тогда, когда Xray не отвечает; её сбой чтение не ломает", async () => {
    const r = rig({ answers: [new XrayStatsUnavailableError(), [up("main", KEY1, 5)]] });
    r.repository.failDelete = true;

    await expect(r.collector.collect(at(0))).resolves.toBeUndefined();
    expect(r.repository.deleted).toHaveLength(1);

    await r.collector.collect(at(1));
    expect(r.repository.list()[0]?.upBytes).toBe(5n);
  });

  it("настоящая очистка удаляет только старое", async () => {
    const r = rig({ answers: [[]] });
    const old = { hour: new Date("2026-10-03T13:00:00.000Z"), subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 1n, downBytes: 1n };
    const edge = { ...old, hour: new Date("2026-10-03T14:00:00.000Z") };
    await r.repository.add([old, edge]);

    await r.collector.collect(NOW);

    expect(r.repository.list().map((row) => row.hour.toISOString())).toEqual(["2026-10-03T14:00:00.000Z"]);
  });
});

describe("снятие счётчиков перед записью конфига", () => {
  const deps = (writer: MemoryConfigWriter, extra: Partial<Parameters<typeof assembleConfig>[0]> = {}) => ({
    repository: new MemorySubscriptionRepository(),
    writer,
    xray: { basePort: 10_800, slotCount: 12, statsPort: 10_799 },
    ...extra,
  });

  it("beforeWrite зовётся до записи config.json", async () => {
    const writer = new MemoryConfigWriter();
    const seen: number[] = [];

    await assembleConfig(deps(writer, { beforeWrite: async () => void seen.push(writer.written.length) }));

    expect(seen).toEqual([0]);
    expect(writer.written).toHaveLength(1);
  });

  it("ошибка beforeWrite запись не останавливает: конфиг записан, в лог — одна строка без текста ошибки", async () => {
    const writer = new MemoryConfigWriter();

    await assembleConfig(
      deps(writer, {
        beforeWrite: async () => {
          throw new Error("секрет-в-тексте");
        },
      }),
    );

    expect(writer.written).toHaveLength(1);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("proxy-traffic") && line.includes("flush_failed"))).toBe(true);
    expect(lines.join("")).not.toContain("секрет-в-тексте");
  });

  it("нет каталога тома — beforeWrite всё равно не мешает ошибке записи дойти до вызывающего", async () => {
    const writer = new MemoryConfigWriter();
    writer.available_ = false;
    await expect(assembleConfig(deps(writer, { beforeWrite: async () => undefined }))).rejects.toThrow();
  });

  it("порт статистики из настроек попадает в конфиг: StatsService на адресе входов", async () => {
    const writer = new MemoryConfigWriter();
    await assembleConfig(deps(writer));
    expect(writer.written[0]).toMatchObject({
      stats: {},
      api: { tag: "api", listen: "0.0.0.0:10799", services: ["StatsService"] },
      policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
    });
  });

  it("порта статистики нет (прежние вызовы) — конфиг без блоков stats, api и policy", async () => {
    const writer = new MemoryConfigWriter();
    await assembleConfig({ repository: new MemorySubscriptionRepository(), writer, xray: { basePort: 10_800, slotCount: 12 } });
    expect(Object.keys(writer.written[0] ?? {})).toEqual(["log", "inbounds", "outbounds", "routing"]);
  });
});

describe("отчёт", () => {
  /** корзины: часы относительно текущего часа */
  async function seeded(): Promise<{ repository: MemoryTraffic; service: TrafficService; collector: TrafficCollector }> {
    const r = rig();
    const row = (hour: Date, subscriptionKey: string, nodeKey: string, nodeName: string, upBytes: number, downBytes: number): TrafficRow => ({ hour, subscriptionKey, nodeKey, nodeName, upBytes: BigInt(upBytes), downBytes: BigInt(downBytes) });
    await r.repository.add([
      row(HOUR, "main", KEY1, "Берлин", 100, 1_000),
      row(hours(-23), "main", KEY1, "Берлин", 10, 20), // 06.11 15:00 — первый час суточного окна
      row(hours(-24), "main", KEY2, "Амстердам", 5, 50), // 06.11 14:00 — уже вне суток
      row(hours(-167), "main", KEY2, "Амстердам", 1, 1), // 31.10 15:00 — первый час недельного окна
      row(hours(-168), "main", KEY2, "Амстердам", 4, 4), // вне недели
      row(hours(-719), "main", KEY2, "Амстердам", 2, 2), // 08.10 15:00 — первый час месячного окна
      row(hours(-720), "main", KEY2, "Амстердам", 8, 8), // вне месяца
      row(HOUR, "main", KEY3, "Ушедший", 1, 2), // узла нет в подписке
      row(HOUR, "gone", KEY1, "Чужой", 500, 500), // подписки нет
      row(HOUR, SECOND, KEY1, "Берлин", 7, 70),
    ]);
    const roles = { require: vi.fn(async () => undefined) } as unknown as RolesService;
    const service = new TrafficService(r.repository, r.subscriptions as unknown as SubscriptionRepository, roles, r.collector);
    return { repository: r.repository, service, collector: r.collector };
  }

  it("сутки: 24 часа до текущего включительно; границы — границы часов", async () => {
    const { service } = await seeded();
    const report = await service.report(ACTOR, "day", NOW);

    expect(report.period).toBe("day");
    expect(report.from).toBe("2026-11-06T15:00:00.000Z");
    expect(report.to).toBe("2026-11-07T15:00:00.000Z");
    expect(report.subscriptions.map((item) => [item.key, item.name, item.upBytes, item.downBytes])).toEqual([
      ["main", "Основная", 111, 1_022],
      [SECOND, "Резервная", 7, 70],
    ]);
  });

  it("неделя и месяц — 168 и 720 часов; байты вне окна не берутся", async () => {
    const { service } = await seeded();

    const week = await service.report(ACTOR, "week", NOW);
    expect(week.from).toBe("2026-10-31T15:00:00.000Z");
    expect(week.subscriptions[0]).toMatchObject({ key: "main", upBytes: 111 + 5 + 1, downBytes: 1_022 + 50 + 1 });

    const month = await service.report(ACTOR, "month", NOW);
    expect(month.from).toBe("2026-10-08T15:00:00.000Z");
    expect(month.to).toBe("2026-11-07T15:00:00.000Z");
    expect(month.subscriptions[0]).toMatchObject({ key: "main", upBytes: 111 + 5 + 1 + 4 + 2, downBytes: 1_022 + 50 + 1 + 4 + 2 });
  });

  it("удалённая подписка в отчёт не попадает; узел вне подписки показан с inSubscription: false и последним названием", async () => {
    const { service } = await seeded();
    const report = await service.report(ACTOR, "day", NOW);

    expect(report.subscriptions.map((item) => item.key)).toEqual(["main", SECOND]);
    expect(JSON.stringify(report)).not.toContain("gone");
    expect(report.subscriptions[0]?.nodes).toEqual([
      { nodeKey: KEY1, name: "Берлин", inSubscription: true, upBytes: 110, downBytes: 1_020 },
      { nodeKey: KEY3, name: "Ушедший", inSubscription: false, upBytes: 1, downBytes: 2 },
    ]);
    expect(report.subscriptions[1]?.nodes).toEqual([{ nodeKey: KEY1, name: "Берлин", inSubscription: true, upBytes: 7, downBytes: 70 }]);
  });

  it("узел из подписки показан под её текущим названием, а не под тем, что записано в корзине", async () => {
    const { service, repository } = await seeded();
    await repository.add([{ hour: hours(1), subscriptionKey: "main", nodeKey: KEY2, nodeName: "Старое имя", upBytes: 1n, downBytes: 1n }]);
    const report = await service.report(ACTOR, "week", hours(1));

    expect(report.subscriptions[0]?.nodes.find((node) => node.nodeKey === KEY2)).toMatchObject({ name: "Амстердам", inSubscription: true });
  });

  it("подписка без трафика остаётся в ответе с нулями и без узлов", async () => {
    const r = rig({ subscriptions: [snapshot("main", "Основная", [[KEY1, "Берлин"]])] });
    const roles = { require: vi.fn(async () => undefined) } as unknown as RolesService;
    const service = new TrafficService(r.repository, r.subscriptions as unknown as SubscriptionRepository, roles, r.collector);

    const report = await service.report(ACTOR, "day", NOW);

    expect(report.subscriptions).toEqual([{ key: "main", name: "Основная", upBytes: 0, downBytes: 0, nodes: [] }]);
  });

  it("узлы подписки — по «всего» по убыванию", async () => {
    const { service } = await seeded();
    const report = await service.report(ACTOR, "week", NOW);
    expect(report.subscriptions[0]?.nodes.map((node) => node.nodeKey)).toEqual([KEY1, KEY2, KEY3]);
  });

  it("lastCollectedAt — null, пока эта реплика не читала счётчики; потом время чтения", async () => {
    const { service, collector } = await seeded();
    expect((await service.report(ACTOR, "day", NOW)).lastCollectedAt).toBeNull();

    await collector.collect(at(2));
    expect((await service.report(ACTOR, "day", NOW)).lastCollectedAt).toBe(at(2).toISOString());
  });

  it("право proxies.view проверяется до чтения базы", async () => {
    const r = rig();
    const require = vi.fn(async () => {
      throw new Error("нет права");
    });
    const service = new TrafficService(r.repository, r.subscriptions as unknown as SubscriptionRepository, { require } as unknown as RolesService, r.collector);
    const spy = vi.spyOn(r.repository, "report");

    await expect(service.report(ACTOR, "day", NOW)).rejects.toThrow("нет права");

    expect(require).toHaveBeenCalledWith(ACTOR, "proxies.view");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("отчёт по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  let repository: MemoryTraffic;

  beforeEach(async () => {
    const r = rig();
    repository = r.repository;
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();

    @Module({
      controllers: [AdminProxyTrafficController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "777000111" } as NodeJS.ProcessEnv) },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: TRAFFIC_REPOSITORY, useValue: r.repository },
        { provide: SUBSCRIPTION_REPOSITORY, useValue: r.subscriptions },
        { provide: TrafficCollector, useValue: r.collector },
        TrafficService,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (const [token, id, role] of [
      ["own", "700000", "owner"],
      ["adm", "700001", "admin"],
      ["mod", "700002", "moderator"],
    ] as const) {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Человек ${id}`, username: null, photoUrl: null }, NOW.getTime());
      await roles.grant(account.accountId, role, null);
      await store.put(hashSessionToken(token), { accountId: account.accountId, platform: "telegram", platformUserId: id, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    }
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function server(): NestFastifyApplication {
    if (app === null) throw new Error("приложение не поднято");
    return app;
  }
  const call = (query: string, token: string) =>
    server().inject({ method: "GET", url: `/api/v1/admin/proxy-traffic${query}`, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE } });

  it("смотреть: владелец и администратор — 200, модератор — 403, без сессии — 401", async () => {
    expect((await call("", "own")).statusCode).toBe(200);
    expect((await call("?period=week", "adm")).statusCode).toBe(200);
    expect((await call("", "mod")).statusCode).toBe(403);
    expect((await server().inject({ method: "GET", url: "/api/v1/admin/proxy-traffic" })).statusCode).toBe(401);
  });

  it("период по умолчанию — сутки; неделя и месяц называются как в спецификации", async () => {
    const day = (await call("", "own")).json() as { data: { period: string; subscriptions: unknown[] } };
    expect(day.data.period).toBe("day");
    expect(day.data.subscriptions).toHaveLength(2);
    expect(((await call("?period=month", "own")).json() as { data: { period: string } }).data.period).toBe("month");
  });

  it("period=year и прочий мусор — 400 до чтения базы", async () => {
    const spy = vi.spyOn(repository, "report");
    for (const query of ["?period=year", "?period=", "?period=DAY", "?period=day&period=week", "?period=1"]) {
      expect((await call(query, "own")).statusCode, query).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("XRAY_STATS_PORT", () => {
  const env = (patch: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...patch }) as NodeJS.ProcessEnv;

  it("по умолчанию 10799 и лежит в config.xray.statsPort", () => {
    expect(loadAppConfig(env()).xray.statsPort).toBe(10_799);
    expect(loadAppConfig(env({ XRAY_STATS_PORT: "20000" })).xray.statsPort).toBe(20_000);
  });

  it("внутри диапазона SOCKS-входов — ошибка с текстом шага 2 спецификации", () => {
    for (const port of ["10800", "10850", "10899"]) {
      expect(() => loadAppConfig(env({ XRAY_STATS_PORT: port })), port).toThrow("XRAY_STATS_PORT пересекается с портами SOCKS-входов Xray");
    }
    expect(() => loadAppConfig(env({ XRAY_SOCKS_PORT_BASE: "10000", XRAY_SLOT_COUNT: "10", XRAY_STATS_PORT: "10009" }))).toThrow("XRAY_STATS_PORT пересекается с портами SOCKS-входов Xray");
  });

  it("сразу за диапазоном и перед ним — можно", () => {
    expect(() => loadAppConfig(env({ XRAY_STATS_PORT: "10799" }))).not.toThrow();
    expect(() => loadAppConfig(env({ XRAY_STATS_PORT: "10900" }))).not.toThrow();
  });

  it("ниже 1024, выше 65535, не целое — ошибка схемы", () => {
    for (const port of ["1023", "65536", "10.5", "abc"]) expect(() => loadAppConfig(env({ XRAY_STATS_PORT: port })), port).toThrow();
  });
});

/** Локальный сервер h2c, играющий Xray: проверяет запрос и отвечает по правилам gRPC. */
interface FakeXray {
  port: number;
  sessions: Set<ServerHttp2Session>;
  close: () => Promise<void>;
}

async function fakeXray(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, body: Buffer) => void): Promise<FakeXray> {
  const server: Http2Server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
    session.on("error", () => undefined);
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", () => undefined);
    stream.on("end", () => handler(stream, headers, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  };
}

function grpcReply(stream: ServerHttp2Stream, message: Uint8Array, status: string = "0"): void {
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": status }));
  stream.end(Buffer.from(grpcFrame(message)));
}

const protoStat = (name: string, value: number): number[] => {
  const encoded = [...new TextEncoder().encode(name)];
  return [0x0a, encoded.length + 4, 0x0a, encoded.length, ...encoded, 0x10, value];
};

describe("клиент gRPC к Xray", () => {
  let xray: FakeXray | null = null;
  afterEach(async () => {
    await xray?.close();
    xray = null;
  });
  const clientOf = (port: number, timeoutMs?: number) => new Http2StatsSource({ host: "127.0.0.1", port, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

  it("POST на путь QueryStats с заголовками gRPC; тело — рамка запроса «outbound>>>» со сбросом; ответ разобран", async () => {
    const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
    const name = `outbound>>>out-main-${KEY1}>>>traffic>>>uplink`;
    xray = await fakeXray((stream, headers, body) => {
      seen.push({ headers, body });
      grpcReply(stream, Uint8Array.from(protoStat(name, 42)));
    });

    const stats = await clientOf(xray.port).query(true);

    expect(stats).toEqual([{ name, value: 42n }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers[":method"]).toBe("POST");
    expect(seen[0]?.headers[":path"]).toBe(STATS_SERVICE_PATH);
    expect(seen[0]?.headers["content-type"]).toBe("application/grpc");
    expect(seen[0]?.headers.te).toBe("trailers");
    expect([...grpcUnframe(seen[0]?.body ?? new Uint8Array())]).toEqual([...encodeQueryStatsRequest({ pattern: "outbound>>>", reset: true })]);
  });

  it("пустой список счётчиков — пустой массив", async () => {
    xray = await fakeXray((stream) => grpcReply(stream, new Uint8Array()));
    expect(await clientOf(xray.port).query(true)).toEqual([]);
  });

  it("сессия закрывается после вызова", async () => {
    xray = await fakeXray((stream) => grpcReply(stream, new Uint8Array()));
    await clientOf(xray.port).query(true);
    await vi.waitFor(() => expect(xray?.sessions.size).toBe(0));
  });

  it("grpc-status не 0 в трейлерах — XrayStatsUnavailableError", async () => {
    xray = await fakeXray((stream) => grpcReply(stream, new Uint8Array(), "14"));
    await expect(clientOf(xray.port).query(true)).rejects.toBeInstanceOf(XrayStatsUnavailableError);
  });

  it("ответ без тела с grpc-status в заголовках: не 0 — ошибка", async () => {
    xray = await fakeXray((stream) => stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "12", "grpc-message": "unknown service" }, { endStream: true }));
    await expect(clientOf(xray.port).query(true)).rejects.toBeInstanceOf(XrayStatsUnavailableError);
  });

  it("код HTTP не 200 — ошибка", async () => {
    xray = await fakeXray((stream) => stream.respond({ ":status": 404 }, { endStream: true }));
    await expect(clientOf(xray.port).query(true)).rejects.toBeInstanceOf(XrayStatsUnavailableError);
  });

  it("тело не по формату gRPC и protobuf — ошибка, а не обрезанный список", async () => {
    xray = await fakeXray((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([1, 2, 3]));
    });
    await expect(clientOf(xray.port).query(true)).rejects.toBeInstanceOf(XrayStatsUnavailableError);

    await xray.close();
    xray = await fakeXray((stream) => grpcReply(stream, Uint8Array.from([0x0a, 0x7f, 0x01])));
    await expect(clientOf(xray.port).query(true)).rejects.toBeInstanceOf(XrayStatsUnavailableError);
  });

  it("сервер молчит — по таймауту ошибка, не зависание", async () => {
    xray = await fakeXray(() => undefined);
    const started = Date.now();
    await expect(clientOf(xray.port, 150).query(true)).rejects.toBeInstanceOf(XrayStatsUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("порт закрыт — ошибка; в тексте нет ни адреса, ни порта", async () => {
    const closed = await fakeXray(() => undefined);
    const { port } = closed;
    await closed.close();

    const error = await clientOf(port, 1_000)
      .query(true)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(XrayStatsUnavailableError);
    expect(String((error as Error).message)).not.toMatch(/127\.0\.0\.1|ECONN|\d{4,}/);
  });
});
