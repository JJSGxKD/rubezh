import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminRequestsController } from "../src/modules/admin/admin-requests.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { BUCKET_COUNT, JOURNAL_CLOCK } from "../src/modules/request-journal/journal-rules.js";
import {
  PrismaRequestJournalRepository,
  REQUEST_JOURNAL_READER,
  type InboundRouteRow,
  type InboundSeriesPoint,
  type OutboundCallRow,
  type OutboundCallsQuery,
  type OutboundServiceRow,
  type RequestJournalReader,
} from "../src/modules/request-journal/request-journal.repository.js";
import { RequestJournalService } from "../src/modules/request-journal/request-journal.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Раздел «Запросы» панели по HTTP (tasks/T-0061): права, разбор периода и
 * параметров, окна от «сейчас» назад, доля ошибок, перцентили из корзин и
 * страницы вызовов. Хранилище журнала — подмена: тут проверяется путь запроса
 * до него и то, что из его строк собирает сервис.
 */

/** 12 октября 2026, 13:06:30 UTC */
const NOW = new Date("2026-10-12T13:06:30.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "777000111" } as NodeJS.ProcessEnv);

/** Корзины с ответами только в одной позиции. */
function bucketsAt(position: number, count: number): number[] {
  const buckets = Array.from({ length: BUCKET_COUNT }, () => 0);
  buckets[position] = count;
  return buckets;
}

/** Хранилище журнала в памяти: запоминает окна и параметры, отдаёт заданные строки. */
class FakeReader implements RequestJournalReader {
  readonly summaryWindows: [Date, Date][] = [];
  readonly routeWindows: [Date, Date][] = [];
  readonly seriesCalls: { from: Date; to: Date; step: string }[] = [];
  readonly callQueries: OutboundCallsQuery[] = [];
  summary: OutboundServiceRow[] = [];
  routes: InboundRouteRow[] = [];
  series: InboundSeriesPoint[] = [];
  calls: OutboundCallRow[] = [];

  async outboundSummary(from: Date, to: Date): Promise<OutboundServiceRow[]> {
    this.summaryWindows.push([from, to]);
    return this.summary;
  }

  async outboundCalls(query: OutboundCallsQuery): Promise<OutboundCallRow[]> {
    this.callQueries.push(query);
    return this.calls
      .filter((call) => (query.service === null || call.service === query.service) && (!query.onlyErrors || !call.ok))
      .filter((call) => query.beforeId === null || BigInt(call.id) < BigInt(query.beforeId))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
      .slice(0, query.limit);
  }

  async inboundRoutes(from: Date, to: Date): Promise<InboundRouteRow[]> {
    this.routeWindows.push([from, to]);
    return this.routes;
  }

  async inboundSeries(from: Date, to: Date, step: "minute" | "hour"): Promise<InboundSeriesPoint[]> {
    this.seriesCalls.push({ from, to, step });
    return this.series;
  }
}

function callOf(id: number, values: Partial<OutboundCallRow> = {}): OutboundCallRow {
  return {
    id: String(id),
    at: new Date(NOW.getTime() - id * 1000),
    service: "telegram.bot",
    method: "POST",
    host: "api.telegram.org",
    path: "/sendMessage",
    status: 200,
    ok: true,
    durationMs: 120,
    via: "direct",
    attempt: 1,
    error: null,
    ...values,
  };
}

interface SummaryBody {
  data: { period: string; from: string; to: string; services: { service: string; count: number; errors: number; errorRate: number; viaProxy: number; median: { ms: number; atLeast: boolean } | null; p95: { ms: number; atLeast: boolean } | null }[] };
}
interface CallsBody {
  data: { calls: { id: string; at: string; service: string; ok: boolean }[]; next: string | null };
}
interface InboundBody {
  data: {
    period: string;
    step: string;
    series: { at: string; total: number; errors: number }[];
    routes: { method: string; route: string; count: number; c4xx: number; c5xx: number; median: { ms: number; atLeast: boolean } | null; p95: { ms: number; atLeast: boolean } | null }[];
  };
}

describe("раздел «Запросы» панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  let reader: FakeReader;

  beforeEach(async () => {
    reader = new FakeReader();
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();

    @Module({
      controllers: [AdminRequestsController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: REQUEST_JOURNAL_READER, useValue: reader },
        { provide: JOURNAL_CLOCK, useValue: () => NOW.getTime() },
        RequestJournalService,
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
      ["gd", "700003", "game_designer"],
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

  const headersOf = (token: string) => ({ cookie: `${ADMIN_SESSION_COOKIE}=${token}` });
  const get = (url: string, token = "adm") => server().inject({ method: "GET", url: `/api/v1/admin/requests/${url}`, headers: headersOf(token) });

  const URLS = ["outbound", "outbound/summary", "inbound"] as const;

  describe("права и разбор", () => {
    it("requests.view в перечне прав; есть только у владельца и администратора", () => {
      expect(PERMISSIONS).toContain("requests.view");
      for (const role of ROLES) expect(ROLE_PERMISSIONS[role].includes("requests.view"), role).toBe(role === "owner" || role === "admin");
    });

    it.each(URLS)("%s: владелец и администратор — 200", async (url) => {
      expect((await get(url, "own")).statusCode).toBe(200);
      expect((await get(url, "adm")).statusCode).toBe(200);
    });

    it.each(URLS)("%s: без requests.view (модератор, геймдизайнер) — 403, хранилище не читается", async (url) => {
      expect((await get(url, "mod")).statusCode).toBe(403);
      expect((await get(url, "gd")).statusCode).toBe(403);
      expect(reader.summaryWindows.length + reader.routeWindows.length + reader.callQueries.length + reader.seriesCalls.length).toBe(0);
    });

    it.each(URLS)("%s: без сессии — 401", async (url) => {
      const response = await server().inject({ method: "GET", url: `/api/v1/admin/requests/${url}` });
      expect(response.statusCode).toBe(401);
    });

    it.each(URLS)("%s: period=year — 400 «Период — час, сутки или неделя»", async (url) => {
      const response = await get(`${url}?period=year`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe("Период — час, сутки или неделя");
    });

    it("параметры вызовов: before не число, служба длиннее колонки — 400", async () => {
      const badBefore = await get("outbound?before=abc");
      const badService = await get(`outbound?service=${"я".repeat(33)}`);
      expect(badBefore.statusCode).toBe(400);
      expect(badService.statusCode).toBe(400);
      expect(reader.callQueries).toEqual([]);
    });
  });

  describe("исходящие: сводка по сервисам", () => {
    it("окно считается от «сейчас» назад: час, сутки (по умолчанию), неделя", async () => {
      await get("outbound/summary?period=hour");
      await get("outbound/summary");
      await get("outbound/summary?period=week");

      expect(reader.summaryWindows.map(([from, to]) => [from.getTime(), to.getTime()])).toEqual([
        [NOW.getTime() - HOUR, NOW.getTime()],
        [NOW.getTime() - DAY, NOW.getTime()],
        [NOW.getTime() - 7 * DAY, NOW.getTime()],
      ]);
    });

    it("доля ошибок и счётчики сервиса; сервис без вызовов времени не выдумывает", async () => {
      reader.summary = [
        { service: "telegram.bot", count: 200, errors: 5, viaProxy: 40, medianMs: 90, p95Ms: 480 },
        { service: "coingecko", count: 0, errors: 0, viaProxy: 0, medianMs: null, p95Ms: null },
      ];

      const body = (await get("outbound/summary")).json() as SummaryBody;

      expect(body.data.period).toBe("day");
      expect(body.data.to).toBe(NOW.toISOString());
      expect(body.data.from).toBe(new Date(NOW.getTime() - DAY).toISOString());
      expect(body.data.services[0]).toMatchObject({ service: "telegram.bot", count: 200, errors: 5, errorRate: 0.025, viaProxy: 40, median: { ms: 90, atLeast: false }, p95: { ms: 480, atLeast: false } });
      expect(body.data.services[1]).toMatchObject({ service: "coingecko", count: 0, errorRate: 0, median: null, p95: null });
    });
  });

  describe("исходящие: последние вызовы", () => {
    it("страницы по сотне: «before» отдаёт следующую, последняя страница без курсора", async () => {
      reader.calls = Array.from({ length: 150 }, (_, index) => callOf(index + 1));

      const first = (await get("outbound")).json() as CallsBody;
      expect(first.data.calls).toHaveLength(100);
      expect(first.data.calls[0]?.id).toBe("150");
      expect(first.data.calls[99]?.id).toBe("51");
      expect(first.data.next).toBe("51");

      const second = (await get(`outbound?before=${first.data.next ?? ""}`)).json() as CallsBody;
      expect(second.data.calls).toHaveLength(50);
      expect(second.data.calls[0]?.id).toBe("50");
      expect(second.data.next).toBeNull();
    });

    it("ровно сотня вызовов — одна страница без курсора", async () => {
      reader.calls = Array.from({ length: 100 }, (_, index) => callOf(index + 1));

      const body = (await get("outbound")).json() as CallsBody;

      expect(body.data.calls).toHaveLength(100);
      expect(body.data.next).toBeNull();
    });

    it("фильтры: служба и «только ошибки» доходят до хранилища вместе с окном периода", async () => {
      reader.calls = [callOf(1), callOf(2, { service: "coingecko" }), callOf(3, { ok: false, status: 500 }), callOf(4, { service: "coingecko", ok: false, status: null, error: "timeout" })];

      const body = (await get("outbound?service=coingecko&errors=1&period=week")).json() as CallsBody;

      expect(body.data.calls.map((call) => call.id)).toEqual(["4"]);
      expect(reader.callQueries[0]).toMatchObject({ service: "coingecko", onlyErrors: true, beforeId: null });
      expect(reader.callQueries[0]?.from.getTime()).toBe(NOW.getTime() - 7 * DAY);
    });

    it("время вызова уходит в UTC-строке ISO", async () => {
      reader.calls = [callOf(1)];

      const body = (await get("outbound")).json() as CallsBody;

      expect(body.data.calls[0]?.at).toBe(new Date(NOW.getTime() - 1000).toISOString());
    });
  });

  describe("входящие: график и маршруты", () => {
    it("шаг графика: час — по минутам, сутки и неделя — по часам; ось без дыр", async () => {
      const hour = (await get("inbound?period=hour")).json() as InboundBody;
      const day = (await get("inbound")).json() as InboundBody;
      const week = (await get("inbound?period=week")).json() as InboundBody;

      expect(reader.seriesCalls.map((call) => call.step)).toEqual(["minute", "hour", "hour"]);
      expect(hour.data.step).toBe("minute");
      expect(day.data.step).toBe("hour");
      // шаги от начала самого раннего шага окна до шага, в котором «сейчас», включительно
      expect(hour.data.series).toHaveLength(61);
      expect(day.data.series).toHaveLength(25);
      expect(week.data.series).toHaveLength(169);
      expect(day.data.series.at(-1)?.at).toBe("2026-10-12T13:00:00.000Z");
      expect(day.data.series[0]?.at).toBe("2026-10-11T13:00:00.000Z");
      expect(day.data.series.every((point) => point.total === 0 && point.errors === 0)).toBe(true);
    });

    it("точки хранилища ложатся на свои шаги, пропущенные шаги — нули", async () => {
      reader.series = [
        { at: new Date("2026-10-12T11:00:00.000Z"), total: 120, errors: 3 },
        { at: new Date("2026-10-12T13:00:00.000Z"), total: 40, errors: 0 },
      ];

      const body = (await get("inbound")).json() as InboundBody;
      const byAt = new Map(body.data.series.map((point) => [point.at, point]));

      expect(byAt.get("2026-10-12T11:00:00.000Z")).toEqual({ at: "2026-10-12T11:00:00.000Z", total: 120, errors: 3 });
      expect(byAt.get("2026-10-12T12:00:00.000Z")).toEqual({ at: "2026-10-12T12:00:00.000Z", total: 0, errors: 0 });
      expect(byAt.get("2026-10-12T13:00:00.000Z")?.total).toBe(40);
    });

    it("маршрут: классы статуса складываются, перцентили — из суммы корзин, порядок — по числу ответов", async () => {
      reader.routes = [
        { method: "GET", route: "/api/v1/me", statusClass: "2xx", count: 90, buckets: bucketsAt(0, 90) },
        { method: "GET", route: "/api/v1/me", statusClass: "4xx", count: 6, buckets: bucketsAt(0, 6) },
        { method: "GET", route: "/api/v1/me", statusClass: "5xx", count: 4, buckets: bucketsAt(3, 4) },
        { method: "POST", route: "/api/v1/runs", statusClass: "2xx", count: 500, buckets: [...bucketsAt(2, 300).map((value, index) => (index === 4 ? 200 : value))] },
      ];

      const body = (await get("inbound")).json() as InboundBody;

      expect(body.data.routes.map((route) => `${route.method} ${route.route}`)).toEqual(["POST /api/v1/runs", "GET /api/v1/me"]);
      expect(body.data.routes[0]).toMatchObject({ count: 500, c4xx: 0, c5xx: 0 });
      // 300 ответов до 100 мс и 200 до 500 мс: медиана — 250-й ответ, 95-й процентиль — 475-й
      expect(body.data.routes[0]?.median).toEqual({ ms: 100, atLeast: false });
      expect(body.data.routes[0]?.p95).toEqual({ ms: 500, atLeast: false });
      // 96 ответов в первой корзине из 100: медиана 25 мс, 95-й процентиль всё ещё в ней, а ответы 97–100 дали 5xx
      expect(body.data.routes[1]).toMatchObject({ count: 100, c4xx: 6, c5xx: 4, median: { ms: 25, atLeast: false }, p95: { ms: 25, atLeast: false } });
    });

    it("верхняя корзина «дольше»: значение 5000 помечено «не меньше», в предпоследней — нет", async () => {
      reader.routes = [
        { method: "GET", route: "/slow", statusClass: "2xx", count: 10, buckets: bucketsAt(BUCKET_COUNT - 1, 10) },
        { method: "GET", route: "/edge", statusClass: "2xx", count: 10, buckets: bucketsAt(BUCKET_COUNT - 2, 10) },
      ];

      const body = (await get("inbound")).json() as InboundBody;
      const byRoute = new Map(body.data.routes.map((route) => [route.route, route]));

      expect(byRoute.get("/slow")?.median).toEqual({ ms: 5000, atLeast: true });
      expect(byRoute.get("/slow")?.p95).toEqual({ ms: 5000, atLeast: true });
      expect(byRoute.get("/edge")?.median).toEqual({ ms: 5000, atLeast: false });
    });

    it("маршрут без корзин — времени нет, а не ноль", async () => {
      reader.routes = [{ method: "GET", route: "/empty", statusClass: "2xx", count: 5, buckets: [] }];

      const body = (await get("inbound")).json() as InboundBody;

      expect(body.data.routes[0]).toMatchObject({ count: 5, median: null, p95: null });
    });
  });
});

/**
 * Чтения журнала на живом Postgres (адрес — TEST_DATABASE_URL, без него
 * пропуск): подмена не покажет, что `percentile_cont` и сложение массивов
 * корзин по позициям написаны верно. Свои строки — по метке в службе и
 * маршруте: таблицы общие на базу.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const SERVICE = "t0061.service";
const ROUTE = "/t0061/runs/:runId";

describe.skipIf(DATABASE_URL === "")("чтения журнала запросов на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaRequestJournalRepository;
  const minute = (minutesAgo: number): Date => new Date(Math.floor(Date.now() / 60_000) * 60_000 - minutesAgo * 60_000);
  const window = (): [Date, Date] => [new Date(Date.now() - DAY), new Date(Date.now() + 60_000)];

  async function clean(): Promise<void> {
    await prisma.outboundCall.deleteMany({ where: { service: SERVICE } });
    await prisma.inboundMinute.deleteMany({ where: { route: { startsWith: "/t0061/" } } });
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 4);
    repository = new PrismaRequestJournalRepository(prisma);
  });

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  const call = (durationMs: number, values: Partial<{ ok: boolean; via: string; status: number | null; error: string | null; at: Date }> = {}) => ({
    at: values.at ?? new Date(Date.now() - 60_000),
    service: SERVICE,
    method: "GET",
    host: "t0061.example",
    path: "/x",
    status: values.status === undefined ? 200 : values.status,
    ok: values.ok ?? true,
    durationMs,
    via: values.via ?? "direct",
    attempt: 1,
    error: values.error ?? null,
  });

  it("сводка исходящих: счётчики, ошибки, прокси, медиана и p95 точные; чужое окно не считается", async () => {
    await prisma.outboundCall.createMany({
      data: [
        call(100),
        call(200, { via: "proxy-1" }),
        call(300, { ok: false, status: 503 }),
        call(400, { ok: false, status: null, error: "timeout" }),
        call(900, { at: new Date(Date.now() - 3 * DAY) }),
      ],
    });

    const rows = await repository.outboundSummary(...window());
    const mine = rows.find((row) => row.service === SERVICE);

    expect(mine).toEqual({ service: SERVICE, count: 4, errors: 2, viaProxy: 1, medianMs: 250, p95Ms: 385 });
  });

  it("вызовы: новые первыми, id строкой, «только ошибки», курсор «раньше», окно периода", async () => {
    await prisma.outboundCall.createMany({
      data: [call(10), call(20, { ok: false, status: 500 }), call(30), call(40, { ok: false, status: 502 }), call(50, { at: new Date(Date.now() - 3 * DAY) })],
    });

    const all = await repository.outboundCalls({ from: window()[0], service: SERVICE, onlyErrors: false, beforeId: null, limit: 100 });
    expect(all.map((row) => row.durationMs)).toEqual([40, 30, 20, 10]);
    expect(typeof all[0]?.id).toBe("string");

    const errors = await repository.outboundCalls({ from: window()[0], service: SERVICE, onlyErrors: true, beforeId: null, limit: 100 });
    expect(errors.map((row) => row.durationMs)).toEqual([40, 20]);

    const older = await repository.outboundCalls({ from: window()[0], service: SERVICE, onlyErrors: false, beforeId: all[1]?.id ?? null, limit: 1 });
    expect(older.map((row) => row.durationMs)).toEqual([20]);
  });

  it("маршруты: счётчики и корзины складываются по минутам, классы статуса остаются раздельно", async () => {
    await prisma.inboundMinute.createMany({
      data: [
        { minute: minute(3), method: "GET", route: ROUTE, statusClass: "2xx", count: 10, buckets: [6, 4, 0, 0, 0, 0, 0, 0, 0] },
        { minute: minute(2), method: "GET", route: ROUTE, statusClass: "2xx", count: 5, buckets: [1, 0, 3, 0, 0, 0, 0, 0, 1] },
        { minute: minute(2), method: "GET", route: ROUTE, statusClass: "5xx", count: 2, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 2] },
      ],
    });

    const rows = (await repository.inboundRoutes(...window())).filter((row) => row.route === ROUTE);
    const byClass = new Map(rows.map((row) => [row.statusClass, row]));

    expect(byClass.get("2xx")).toMatchObject({ count: 15, buckets: [7, 4, 3, 0, 0, 0, 0, 0, 1] });
    expect(byClass.get("5xx")).toMatchObject({ count: 2, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 2] });
  });

  it("график: шаг «час» собирает минуты часа, 5xx — отдельным числом; шаг «минута» оставляет минуты", async () => {
    const hourStart = new Date(Math.floor((Date.now() - 2 * 3_600_000) / 3_600_000) * 3_600_000);
    await prisma.inboundMinute.createMany({
      data: [
        { minute: new Date(hourStart.getTime() + 5 * 60_000), method: "GET", route: ROUTE, statusClass: "2xx", count: 10, buckets: [10, 0, 0, 0, 0, 0, 0, 0, 0] },
        { minute: new Date(hourStart.getTime() + 6 * 60_000), method: "GET", route: ROUTE, statusClass: "5xx", count: 3, buckets: [3, 0, 0, 0, 0, 0, 0, 0, 0] },
      ],
    });
    const from = new Date(hourStart.getTime() - 60_000);
    const to = new Date(hourStart.getTime() + 3_600_000);

    const hourly = await repository.inboundSeries(from, to, "hour");
    const minutely = await repository.inboundSeries(from, to, "minute");

    // таблица общая: чужие строки могут лечь в тот же час, поэтому «не меньше»
    const hour = hourly.find((point) => point.at.getTime() === hourStart.getTime());
    expect(hour?.total).toBeGreaterThanOrEqual(13);
    expect(hour?.errors).toBeGreaterThanOrEqual(3);
    const sixth = minutely.find((point) => point.at.getTime() === hourStart.getTime() + 6 * 60_000);
    expect(sixth?.errors).toBeGreaterThanOrEqual(3);
    expect(minutely.length).toBeGreaterThan(1);
  });
});
