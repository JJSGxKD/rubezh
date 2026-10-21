import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { CSP_REPORT_BODY_LIMIT_BYTES, createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { CspReportsAdminController, CspReportsController } from "../src/modules/csp-reports/csp-reports.controller.js";
import { CSP_REPORTS_REPOSITORY, type CspReportsRepository, type CspStoredEntry } from "../src/modules/csp-reports/csp-reports.repository.js";
import { CspReportsService } from "../src/modules/csp-reports/csp-reports.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Маршруты отчётов политики источников: приём от браузера без входа и сводка
 * для панели (Р108, tasks/T-0155). Хранилище и Redis — подмены; логику разбора
 * проверяет `csp-reports.test.ts`, Lua-скрипт — интеграционный тест.
 */

const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

class FakeRepository implements CspReportsRepository {
  readonly recorded: { directive: string; host: string }[] = [];
  entries: CspStoredEntry[] = [];

  async record(hit: { directive: string; host: string }): Promise<void> {
    this.recorded.push({ ...hit });
  }

  async read(): Promise<{ entries: CspStoredEntry[]; overflow: number }> {
    return { entries: this.entries, overflow: 3 };
  }
}

/** Redis ровно настолько, насколько его трогает лимит частоты: счётчик окна. */
function countingRedis(): Redis {
  const counters = new Map<string, number>();
  return {
    eval: async (_script: string, _keys: number, key: string, cost: string) => {
      const next = (counters.get(key) ?? 0) + Number(cost);
      counters.set(key, next);
      return next;
    },
  } as unknown as Redis;
}

const apps: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((created) => created.close()));
});

async function start() {
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const store = new MemoryAdminSessionStore();
  const repository = new FakeRepository();
  const person = async (id: string, role: Role, cookie: string) => {
    const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: id, username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(account.accountId, role, null);
    await store.put(hashSessionToken(cookie), { accountId: account.accountId, platform: "telegram", platformUserId: id, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
  };
  await person("1", "owner", "own");
  await person("2", "moderator", "mod");

  @Module({
    controllers: [CspReportsController, CspReportsAdminController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: REDIS, useValue: countingRedis() },
      { provide: ACCOUNT_REPOSITORY, useValue: accounts },
      { provide: ROLES_REPOSITORY, useValue: rolesRepository },
      { provide: ADMIN_SESSION_STORE, useValue: store },
      { provide: CSP_REPORTS_REPOSITORY, useValue: repository },
      CspReportsService,
      RateLimiter,
      RolesService,
      PermissionGuard,
      AdminSessionService,
      AdminSessionGuard,
    ],
  })
  class TestModule {}
  const app = await createHttpApp(TestModule, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return { app, repository };
}

const URI_REPORT = JSON.stringify({
  "csp-report": {
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://7ool.net/richpartners/pops/js/md5.js?x=1",
    "document-uri": "https://rubezh.gonet.fun/?tgWebAppData=секрет",
  },
});

describe("POST /csp-reports", () => {
  const post = (server: NestFastifyApplication, contentType: string, payload: string, headers: Record<string, string> = {}) =>
    server.inject({ method: "POST", url: "/api/v1/csp-reports", payload, headers: { "content-type": contentType, ...headers } });

  it("application/csp-report — 204, попадание записано без пути и адреса страницы", async () => {
    const { app, repository } = await start();

    const response = await post(app, "application/csp-report", URI_REPORT);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(repository.recorded).toEqual([{ directive: "script-src-elem", host: "7ool.net" }]);
  });

  it("application/reports+json с массивом — 204", async () => {
    const { app, repository } = await start();
    const body = JSON.stringify([
      { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://a.example/p.gif" } },
      { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://b.example/p.gif" } },
    ]);

    const response = await post(app, "application/reports+json", body);

    expect(response.statusCode).toBe(204);
    expect(repository.recorded).toHaveLength(2);
  });

  it("application/json — 204, тело тоже разбирается", async () => {
    const { app, repository } = await start();

    const response = await post(app, "application/json", URI_REPORT);

    expect(response.statusCode).toBe(204);
    expect(repository.recorded).toHaveLength(1);
  });

  it("тип с параметрами (charset) не мешает", async () => {
    const { app, repository } = await start();

    expect((await post(app, "application/csp-report; charset=utf-8", URI_REPORT)).statusCode).toBe(204);
    expect(repository.recorded).toHaveLength(1);
  });

  it("мусорное, но корректное JSON-тело — 204 и ничего не записано", async () => {
    const { app, repository } = await start();

    expect((await post(app, "application/csp-report", "[1,2,3]")).statusCode).toBe(204);
    expect(repository.recorded).toEqual([]);
  });

  it("text/html — 415", async () => {
    const { app } = await start();

    expect((await post(app, "text/html", "<p>x</p>")).statusCode).toBe(415);
  });

  it("битый JSON в application/csp-report — 400", async () => {
    const { app, repository } = await start();

    const response = await post(app, "application/csp-report", "{не json");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(repository.recorded).toEqual([]);
  });

  it("тело больше 16 КБ — 413", async () => {
    const { app } = await start();
    const padding = "a".repeat(CSP_REPORT_BODY_LIMIT_BYTES + 1);

    const response = await post(app, "application/csp-report", JSON.stringify({ "csp-report": { "blocked-uri": padding } }));

    expect(CSP_REPORT_BODY_LIMIT_BYTES).toBe(16 * 1024);
    expect(response.statusCode).toBe(413);
  });

  it("без заголовка Origin запрос проходит", async () => {
    const { app } = await start();

    const response = await post(app, "application/csp-report", URI_REPORT);

    expect(response.statusCode).toBe(204);
  });

  it("лимит 300 в минуту с одного адреса: 301-й — 429", async () => {
    const { app } = await start();

    for (let index = 0; index < 300; index += 1) {
      expect((await post(app, "application/csp-report", URI_REPORT)).statusCode).toBe(204);
    }

    expect((await post(app, "application/csp-report", URI_REPORT)).statusCode).toBe(429);
  });
});

describe("GET /admin/csp-reports", () => {
  const get = (server: NestFastifyApplication, cookie?: string) =>
    server.inject({ method: "GET", url: "/api/v1/admin/csp-reports", headers: cookie === undefined ? {} : { cookie: `${ADMIN_SESSION_COOKIE}=${cookie}` } });

  it("без сессии панели — 401", async () => {
    const { app } = await start();

    expect((await get(app)).statusCode).toBe(401);
  });

  it("без права diagnostics.view — 403", async () => {
    const { app } = await start();

    expect((await get(app, "mod")).statusCode).toBe(403);
  });

  it("с правом — сводка: свежие сверху, ISO-дата, переполнение и потолок", async () => {
    const { app, repository } = await start();
    repository.entries = [
      { directive: "script-src", host: "old.example", count: 9, lastAtMs: Date.parse("2026-10-01T10:00:00.000Z") },
      { directive: "img-src", host: "new.example", count: 2, lastAtMs: Date.parse("2026-10-19T12:30:00.000Z") },
    ];

    const response = await get(app, "own");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        entries: [
          { directive: "img-src", host: "new.example", count: 2, lastAt: "2026-10-19T12:30:00.000Z" },
          { directive: "script-src", host: "old.example", count: 9, lastAt: "2026-10-01T10:00:00.000Z" },
        ],
        overflow: 3,
        maxEntries: 200,
      },
    });
  });
});
