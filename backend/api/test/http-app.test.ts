import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { HealthController } from "../src/health/health.controller.js";
import { BODY_LIMIT_BYTES, createHttpApp } from "../src/http-app.js";
import { PlaytestAuthGuard } from "../src/modules/playtest/playtest-auth.guard.js";
import { PlaytestController } from "../src/modules/playtest/playtest.controller.js";
import { PlaytestService } from "../src/modules/playtest/playtest.service.js";
import { PLAYTEST_STATS_STORE } from "../src/modules/playtest/playtest-stats.store.js";
import { PLAYTEST_STORE } from "../src/modules/playtest/playtest.store.js";
import { MemoryPlaytestStatsStore } from "./helpers/memory-playtest-stats.store.js";
import { MemoryPlaytestStore } from "./helpers/memory-playtest.store.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

// HTTP-слой на настоящем Fastify (docs/17-testing-strategy.md §4): префикс,
// форма ошибок, лимит тела, гвард и CORS — так, как их увидит клиент.

function moduleFor(env: Record<string, string>): Type<unknown> {
  @Module({
    controllers: [HealthController, PlaytestController],
    providers: [
      { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "development", ...env }) },
      PlaytestAuthGuard,
      PlaytestService,
      // Плейтест спрашивает права: инструменты команды открываются по
      // `tools.dev`, а не по списку Telegram ID (docs/34-stage3-plan.md, WP2).
      {
        provide: RolesService,
        useFactory: (config: AppConfig) => new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()),
        inject: [APP_CONFIG],
      },
      { provide: PLAYTEST_STORE, useValue: new MemoryPlaytestStore() },
      { provide: PLAYTEST_STATS_STORE, useValue: new MemoryPlaytestStatsStore() },
    ],
  })
  class TestModule {}
  return TestModule;
}

const DEV_USER = { "x-playtest-dev-user": encodeURIComponent("dev-http:Проверка") };

describe("HTTP-приложение на Fastify", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createHttpApp(
      moduleFor({
        PLAYTEST_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "123456:TEST",
        PLAYTEST_DEV_AUTH: "true",
        ALLOWED_ORIGINS: "https://rubezh.example",
      }),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("держит health на корне, а API — под /api/v1", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const profile = await app.inject({ method: "GET", url: "/api/v1/playtest/me", headers: DEV_USER });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ data: { recent: [] } });
  });

  it("отвечает на неизвестный путь общей формой ошибки", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/no-such-thing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "Не найдено" } });
  });

  it("не пускает без подписи запуска", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/playtest/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("отвечает 400 на битый JSON, не раскрывая подробностей разбора", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/playtest/runs",
      headers: { ...DEV_USER, "content-type": "application/json" },
      payload: '{"runId": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "bad_request", message: "Некорректный запрос" } });
  });

  it("отвечает 413 на тело сверх лимита", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/playtest/runs",
      headers: { ...DEV_USER, "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(BODY_LIMIT_BYTES) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("отвечает 400 с кодом на тело не по схеме", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/playtest/runs",
      headers: DEV_USER,
      payload: { runId: "не uuid" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("разрешает CORS только своим доменам", async () => {
    const own = await app.inject({ method: "OPTIONS", url: "/api/v1/playtest/me", headers: { origin: "https://rubezh.example", "access-control-request-method": "GET" } });
    expect(own.headers["access-control-allow-origin"]).toBe("https://rubezh.example");
    const foreign = await app.inject({ method: "OPTIONS", url: "/api/v1/playtest/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("выключенный плейтест", () => {
  it("отвечает 404 и не подтверждает, что эндпоинт есть", async () => {
    const app = await createHttpApp(moduleFor({}), { logger: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const response = await app.inject({ method: "GET", url: "/api/v1/playtest/me", headers: DEV_USER });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "endpoint_disabled" } });
    } finally {
      await app.close();
    }
  });
});
