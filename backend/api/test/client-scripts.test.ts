import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ClientScriptsController } from "../src/modules/client-scripts/client-scripts.controller.js";
import { ClientScripts } from "../src/modules/client-scripts/client-scripts.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { SETTING_LIST } from "../src/modules/settings/setting-catalog.js";
import { SETTINGS_READER } from "../src/modules/settings/settings.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { panelSettings } from "./helpers/settings.js";

// Выключатели чужих скриптов клиента (tasks/T-0055, docs/35-stage4-plan.md Р93):
// Graspil, SDK учёта аудитории и всё сразу — из панели, без релиза.

describe("настройки внешних скриптов", () => {
  it("все три включены по умолчанию и стоят в группе «Внешние скрипты клиента»", () => {
    const scripts = SETTING_LIST.filter((setting) => setting.key.startsWith("client.scripts."));
    expect(scripts.map((setting) => setting.key).sort()).toEqual(["client.scripts.ad-audience", "client.scripts.all", "client.scripts.graspil"]);
    for (const setting of scripts) {
      expect(setting.group).toBe("Внешние скрипты клиента");
      expect(setting.kind).toBe("boolean");
      expect(setting.fallback).toBe(true);
      expect(setting.hint.length).toBeGreaterThan(20);
    }
  });
});

describe("ClientScripts", () => {
  it("все включены — все три разрешены", () => {
    const scripts = new ClientScripts(panelSettings());
    expect([scripts.graspil(), scripts.adAudience(), scripts.ads()]).toEqual([true, true, true]);
  });

  it("выключен Graspil — остальное работает", () => {
    const scripts = new ClientScripts(panelSettings({ "client.scripts.graspil": false }));
    expect([scripts.graspil(), scripts.adAudience(), scripts.ads()]).toEqual([false, true, true]);
  });

  it("выключен учёт аудитории — остальное работает", () => {
    const scripts = new ClientScripts(panelSettings({ "client.scripts.ad-audience": false }));
    expect([scripts.graspil(), scripts.adAudience(), scripts.ads()]).toEqual([true, false, true]);
  });

  it("аварийный выключатель гасит всё, даже при включённых остальных", () => {
    const scripts = new ClientScripts(panelSettings({ "client.scripts.all": false, "client.scripts.graspil": true, "client.scripts.ad-audience": true }));
    expect([scripts.graspil(), scripts.adAudience(), scripts.ads()]).toEqual([false, false, false]);
  });

  it("правка из панели видна сразу, без перезапуска", () => {
    const settings = panelSettings();
    const scripts = new ClientScripts(settings);
    settings.set("client.scripts.graspil", false);
    expect(scripts.graspil()).toBe(false);
  });
});

describe("GET /api/v1/client/scripts", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(settings = panelSettings()): Promise<NestFastifyApplication> {
    @Module({
      controllers: [ClientScriptsController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: SETTINGS_READER, useValue: settings },
        ClientScripts,
        RateLimiter,
      ],
    })
    class TestModule {}
    const created = await createHttpApp(TestModule, { logger: false });
    await created.init();
    await created.getHttpAdapter().getInstance().ready();
    return created;
  }

  it("без токена отвечает 200 и разрешением Graspil", async () => {
    app = await start();
    const response = await app.inject({ method: "GET", url: "/api/v1/client/scripts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { graspil: true } });
  });

  it("выключенный Graspil — graspil: false", async () => {
    app = await start(panelSettings({ "client.scripts.graspil": false }));
    expect((await app.inject({ method: "GET", url: "/api/v1/client/scripts" })).json()).toEqual({ data: { graspil: false } });
  });

  it("ответ кэшируется на минуту: он один у всех, CDN снимает его с сервера", async () => {
    app = await start();
    const response = await app.inject({ method: "GET", url: "/api/v1/client/scripts" });
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("61-й запрос с одного адреса за минуту — 429", async () => {
    app = await start();
    for (let n = 0; n < 60; n += 1) {
      expect((await app.inject({ method: "GET", url: "/api/v1/client/scripts" })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/client/scripts" })).statusCode).toBe(429);
  });
});
