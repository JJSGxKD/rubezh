import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { HealthController } from "../src/health/health.controller.js";
import { BODY_LIMIT_BYTES, createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { LEADERBOARD_STORE } from "../src/modules/runs/leaderboard.store.js";
import { RunsController } from "../src/modules/runs/runs.controller.js";
import { RUNS_REPOSITORY } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository } from "./helpers/memory-runs.js";

// HTTP-слой на настоящем Fastify (docs/17-testing-strategy.md §4): префикс,
// форма ошибок, лимит тела, гвард и CORS — так, как их увидит клиент. Проверка
// идёт на забегах: это главный изменяющий эндпоинт игрока.

/** Лимит частоты уходит на память, когда Redis недоступен, — тестам этого хватает. */
const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

function moduleFor(env: Record<string, string>): Type<unknown> {
  const config = loadAppConfig({ NODE_ENV: "development", ...env });
  @Module({
    controllers: [HealthController, RunsController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: REDIS, useValue: unavailableRedis },
      { provide: RUNS_REPOSITORY, useValue: new MemoryRunsRepository() },
      { provide: LEADERBOARD_STORE, useValue: new MemoryLeaderboardStore() },
      {
        provide: RolesService,
        useFactory: (cfg: AppConfig) => new RolesService(cfg, new MemoryRolesRepository(), new MemoryAccountRepository()),
        inject: [APP_CONFIG],
      },
      AuthGuard,
      RateLimiter,
      RunsHooks,
      RunContinues,
      RunsService,
      RunsViewService,
    ],
  })
  class TestModule {}
  return TestModule;
}

async function bearer(): Promise<Record<string, string>> {
  const claims = { accountId: randomUUID(), platform: "telegram" as const, platformUserId: "555" };
  return { authorization: `Bearer ${await signAccessToken(claims, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now())}` };
}

describe("HTTP-приложение на Fastify", () => {
  let app: NestFastifyApplication;
  let auth: Record<string, string>;

  beforeAll(async () => {
    app = await createHttpApp(moduleFor({ ...AUTH_ENV, ALLOWED_ORIGINS: "https://rubezh.example" }), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    auth = await bearer();
  });

  afterAll(async () => {
    await app.close();
  });

  it("держит health на корне, а API — под /api/v1", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const profile = await app.inject({ method: "GET", url: "/api/v1/runs/me", headers: auth });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ data: { recent: [] } });
  });

  it("отвечает на неизвестный путь общей формой ошибки", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/no-such-thing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "Не найдено" } });
  });

  it("не пускает без токена доступа", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("отвечает 400 на битый JSON, не раскрывая подробностей разбора", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: '{"runId": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "bad_request", message: "Некорректный запрос" } });
  });

  it("отвечает 413 на тело сверх лимита", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(BODY_LIMIT_BYTES) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("отвечает 400 с кодом на тело не по схеме", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/runs", headers: auth, payload: { runId: "x" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("разрешает CORS только своим доменам", async () => {
    const own = await app.inject({ method: "OPTIONS", url: "/api/v1/runs/me", headers: { origin: "https://rubezh.example", "access-control-request-method": "GET" } });
    expect(own.headers["access-control-allow-origin"]).toBe("https://rubezh.example");
    const foreign = await app.inject({ method: "OPTIONS", url: "/api/v1/runs/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("выключенная авторизация", () => {
  it("отвечает 404 и не подтверждает, что эндпоинт есть", async () => {
    const app = await createHttpApp(moduleFor({}), { logger: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const response = await app.inject({ method: "GET", url: "/api/v1/runs/me", headers: await bearer() });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "endpoint_disabled" } });
    } finally {
      await app.close();
    }
  });
});
