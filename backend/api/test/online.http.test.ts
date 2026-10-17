import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { OnlineAdminController, OnlineController } from "../src/modules/online/online.controller.js";
import type { OnlineCounts, OnlinePeak, OnlineRepository } from "../src/modules/online/online.repository.js";
import { OnlineService } from "../src/modules/online/online.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { SETTINGS_READER } from "../src/modules/settings/settings.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Маршруты счётчика онлайна: пинг игрока под сессией и снимок для панели.
 * Хранилище и Redis — подмены; пороги и числа проверяет `online.test.ts`.
 */

const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
const ACCOUNT = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f60";

const COUNTS: OnlineCounts = {
  byPlatform: {
    telegram: { app: 30, run: 7, today: 120 },
    max: { app: 2, run: 0, today: 5 },
    vk: { app: 0, run: 0, today: 0 },
    web: { app: 0, run: 0, today: 0 },
  },
  total: { app: 32, run: 7, today: 125 },
  at: 1_000,
};

class FakeRepository implements OnlineRepository {
  inRun: boolean[] = [];
  async touch(): Promise<void> {}
  async setInRun(_accountId: string, _platform: string, inRun: boolean): Promise<void> {
    this.inRun.push(inRun);
  }
  async recount(): Promise<OnlineCounts> {
    return COUNTS;
  }
  async counts(): Promise<OnlineCounts | null> {
    return COUNTS;
  }
  async peak(): Promise<OnlinePeak | null> {
    return { value: 41, at: 500 };
  }
  async setPeak(): Promise<void> {}
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
    controllers: [OnlineController, OnlineAdminController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: REDIS, useValue: countingRedis() },
      { provide: ACCOUNT_REPOSITORY, useValue: accounts },
      { provide: ROLES_REPOSITORY, useValue: rolesRepository },
      { provide: ADMIN_SESSION_STORE, useValue: store },
      { provide: SETTINGS_READER, useValue: panelSettings({ "online.min-shown": 20 }) },
      { provide: OnlineService, inject: [SETTINGS_READER], useFactory: (settings: ReturnType<typeof panelSettings>) => new OnlineService(repository, settings) },
      RateLimiter,
      RolesService,
      PermissionGuard,
      AdminSessionService,
      AdminSessionGuard,
      AuthGuard,
    ],
  })
  class TestModule {}
  const app = await createHttpApp(TestModule, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return { app, repository };
}

const bearer = async (): Promise<string> =>
  `Bearer ${await signAccessToken({ accountId: ACCOUNT, platform: "telegram", platformUserId: "7" }, secretKey(config.auth.accessSecret), 900, Date.now())}`;

describe("POST /online/ping", () => {
  const ping = async (server: NestFastifyApplication, payload: unknown, authorization?: string) =>
    server.inject({ method: "POST", url: "/api/v1/online/ping", payload: payload as object, headers: authorization === undefined ? {} : { authorization } });

  it("без токена — 401", async () => {
    const { app } = await start();

    expect((await ping(app, { inRun: false })).statusCode).toBe(401);
  });

  it("тело без inRun или с чужим типом — 400", async () => {
    const { app } = await start();
    const authorization = await bearer();

    expect((await ping(app, {}, authorization)).statusCode).toBe(400);
    expect((await ping(app, { inRun: "yes" }, authorization)).statusCode).toBe(400);
  });

  it("с токеном — числа по порогам и интервал, состояние «в забеге» записано", async () => {
    const { app, repository } = await start();

    const response = await ping(app, { inRun: true }, await bearer());

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ data: { online: 32, inRun: 7, todayPlayed: null, nextPingSec: 45 } });
    expect(repository.inRun).toEqual([true]);
  });

  it("лимит 240 в час: 241-й пинг — 429", async () => {
    const { app } = await start();
    const authorization = await bearer();

    for (let index = 0; index < 240; index += 1) {
      expect((await ping(app, { inRun: false }, authorization)).statusCode).toBe(201);
    }

    expect((await ping(app, { inRun: false }, authorization)).statusCode).toBe(429);
  });
});

describe("GET /admin/online", () => {
  const get = (server: NestFastifyApplication, cookie?: string) =>
    server.inject({ method: "GET", url: "/api/v1/admin/online", headers: cookie === undefined ? {} : { cookie: `${ADMIN_SESSION_COOKIE}=${cookie}` } });

  it("без сессии панели — 401", async () => {
    const { app } = await start();

    expect((await get(app)).statusCode).toBe(401);
  });

  it("без права аналитики геймплея — 403", async () => {
    const { app } = await start();

    expect((await get(app, "mod")).statusCode).toBe(403);
  });

  it("с правом — снимок по площадкам, итог и рекорд без порогов", async () => {
    const { app } = await start();

    const response = await get(app, "own");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { byPlatform: COUNTS.byPlatform, total: COUNTS.total, peak: { value: 41, at: 500 }, at: 1_000 } });
  });

  it("токен игрока в панель не пускает: онлайн игроков и сессия панели — разные двери", async () => {
    const { app } = await start();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/online", headers: { authorization: await bearer() } });

    expect(response.statusCode).toBe(401);
  });
});
