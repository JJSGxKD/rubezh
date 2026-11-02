import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { FeedController } from "../src/modules/feed/feed.controller.js";
import { FeedModule } from "../src/modules/feed/feed.module.js";
import { FeedService } from "../src/modules/feed/feed.service.js";
import type { FeedView } from "../src/modules/feed/feed-events.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { AuthModule } from "../src/modules/auth/auth.module.js";
import { RestrictionsModule } from "../src/modules/restrictions/restrictions.module.js";
import { RunsModule } from "../src/modules/runs/runs.module.js";
import { SeasonsModule } from "../src/modules/seasons/seasons.module.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Маршрут ленты: вход под сессией игрока, лимит, форма ответа. Сервис —
 * подмена, его правила проверяет `feed.test.ts`; здесь же проверка сборки
 * модулей — то, чего поштучные тесты не видят.
 */

const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
const ACCOUNT = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f60";

const VIEW: FeedView = {
  events: [{ id: "0123456789ab", kind: "long_run", name: "Алиса", at: "2026-11-04T11:00:00.000Z", seconds: 700 }],
  refreshSec: 300,
};

class FakeFeedService {
  calls = 0;
  view: FeedView = VIEW;
  async getView(): Promise<FeedView> {
    this.calls += 1;
    return this.view;
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
  const service = new FakeFeedService();

  @Module({
    controllers: [FeedController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: REDIS, useValue: countingRedis() },
      { provide: FeedService, useValue: { view: async () => await service.getView() } },
      RateLimiter,
      AuthGuard,
    ],
  })
  class TestModule {}
  const app = await createHttpApp(TestModule, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return { app, service };
}

const bearer = async (): Promise<string> =>
  `Bearer ${await signAccessToken({ accountId: ACCOUNT, platform: "telegram", platformUserId: "7" }, secretKey(config.auth.accessSecret), 900, Date.now())}`;

const get = (server: NestFastifyApplication, authorization?: string, url = "/api/v1/feed") =>
  server.inject({ method: "GET", url, headers: authorization === undefined ? {} : { authorization } });

describe("GET /feed", () => {
  it("без токена — 401", async () => {
    const { app, service } = await start();

    expect((await get(app)).statusCode).toBe(401);
    expect(service.calls).toBe(0);
  });

  it("с токеном — { data: { events, refreshSec } }", async () => {
    const { app } = await start();

    const response = await get(app, await bearer());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: VIEW });
  });

  it("пустая лента — events: []", async () => {
    const { app, service } = await start();
    service.view = { events: [], refreshSec: 300 };

    const response = await get(app, await bearer());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { events: [], refreshSec: 300 } });
  });

  it("чужие параметры игнорируются: лента одна для всех, фильтров нет", async () => {
    const { app } = await start();

    const response = await get(app, await bearer(), "/api/v1/feed?limit=500&accountId=x&kind=boss");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: VIEW });
  });

  it("лимит 120 в час на аккаунт: 121-й запрос — 429", async () => {
    const { app } = await start();
    const authorization = await bearer();

    for (let index = 0; index < 120; index += 1) {
      expect((await get(app, authorization)).statusCode).toBe(200);
    }

    expect((await get(app, authorization)).statusCode).toBe(429);
  });
});

describe("сборка модулей", () => {
  it("SeasonsModule экспортирует SeasonSchedule, а FeedModule импортирует нужные модули", () => {
    const exported = Reflect.getMetadata("exports", SeasonsModule) as unknown[];
    const imported = Reflect.getMetadata("imports", FeedModule) as unknown[];

    expect(exported).toContain(SeasonSchedule);
    for (const module of [AuthModule, RunsModule, SeasonsModule, RestrictionsModule]) expect(imported).toContain(module);
  });

  it("FeedService просит у контейнера именно SeasonSchedule", () => {
    const parameters = Reflect.getMetadata("design:paramtypes", FeedService) as unknown[];

    expect(parameters).toContain(SeasonSchedule);
  });
});
