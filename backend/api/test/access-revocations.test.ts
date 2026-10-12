import "reflect-metadata";
import { Controller, Get, Global, Logger, Module, UseGuards } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { PRISMA } from "../src/infra/database.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AccessRevocations } from "../src/modules/auth/access-revocations.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { AuthModule } from "../src/modules/auth/auth.module.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { LaunchVerifiers } from "../src/platforms/ports/launch-verifier.js";

/**
 * Отзыв токенов доступа «выйти везде» и блокировкой: метка времени в Redis,
 * токен, выданный раньше неё, не принимается. Redis — подмена на Map.
 */

const config = loadAppConfig({
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "ab".repeat(32),
  TELEGRAM_BOT_TOKEN: "123456:TEST",
  DATABASE_URL: "postgresql://localhost:5432/test",
} as NodeJS.ProcessEnv);

function fakeRedis() {
  const store = new Map<string, string>();
  const sets: unknown[][] = [];
  return {
    store,
    sets,
    set: vi.fn(async (...args: unknown[]) => {
      sets.push(args);
      store.set(String(args[0]), String(args[1]));
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

describe("отзыв токенов доступа", () => {
  afterEach(() => vi.restoreAllMocks());

  it("токен, выданный раньше секунды отзыва, отозван; в ту же секунду и позже — нет", async () => {
    const redis = fakeRedis();
    const revocations = new AccessRevocations(redis as never, config);

    await revocations.revokeBefore("acc", 10_500);

    expect(await revocations.isRevoked("acc", 9)).toBe(true);
    expect(await revocations.isRevoked("acc", 10)).toBe(false);
    expect(await revocations.isRevoked("acc", 11)).toBe(false);
  });

  it("метка ставится с жизнью на 60 секунд дольше токена доступа", async () => {
    const redis = fakeRedis();

    await new AccessRevocations(redis as never, config).revokeBefore("acc", 10_500);

    expect(redis.sets).toEqual([["auth:revoked-before:acc", "10", "EX", config.auth.accessTtlSec + 60]]);
  });

  it("без отзыва ничего не отозвано", async () => {
    const revocations = new AccessRevocations(fakeRedis() as never, config);

    expect(await revocations.isRevoked("acc", 1)).toBe(false);
  });

  it("отзыв одного аккаунта не касается другого", async () => {
    const revocations = new AccessRevocations(fakeRedis() as never, config);

    await revocations.revokeBefore("acc", 10_500);

    expect(await revocations.isRevoked("other", 1)).toBe(false);
  });

  it("недоступный Redis не роняет проверку: токен пропускается, в лог идёт предупреждение", async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const revocations = new AccessRevocations(redis as never, config);

    expect(await revocations.isRevoked("acc", 1)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      module: "auth",
      event: "revocation_check_failed",
      reason: "connection refused",
    });
  });
});

/**
 * Отзыв токенов доступа на маршруте ДРУГОГО модуля: `@UseGuards(AuthGuard)`
 * Nest собирает в модуле контроллера, а не в `AuthModule`, поэтому
 * `AccessRevocations` обязан экспортироваться — иначе необязательная
 * зависимость гарда молча пуста и отзыв не действует нигде, кроме самого
 * `AuthController`. Юнит-тесты гарда собирают его руками и этого не видят.
 */
const ACCOUNT = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f60";
const NOW_MS = Date.now();

/** Redis ровно настолько, насколько его трогает отзыв; лимит частоты уходит в память процесса. */
const store = new Map<string, string>();
const redis = {
  eval: async () => Promise.reject(new Error("no eval")),
  set: async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  },
  get: async (key: string) => store.get(key) ?? null,
};

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: REDIS, useValue: redis },
    { provide: PRISMA, useValue: {} },
    { provide: LaunchVerifiers, useValue: new LaunchVerifiers([]) },
    RateLimiter,
  ],
  exports: [APP_CONFIG, REDIS, PRISMA, LaunchVerifiers, RateLimiter],
})
class InfraStub {}

@Controller("probe")
@UseGuards(AuthGuard)
class ProbeController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

/** Чужой модуль, как `runs`, `shop` или `wallet`: импортирует AuthModule и закрывает маршрут его гардом. */
@Module({ imports: [AuthModule], controllers: [ProbeController] })
class ForeignModule {}

@Module({ imports: [InfraStub, AuthModule, ForeignModule] })
class TestModule {}

const apps: NestFastifyApplication[] = [];

async function app(): Promise<NestFastifyApplication> {
  const created = await createHttpApp(TestModule, { logger: false });
  await created.init();
  await created.getHttpAdapter().getInstance().ready();
  apps.push(created);
  return created;
}

const tokenIssuedAt = (ms: number): Promise<string> =>
  signAccessToken({ accountId: ACCOUNT, platform: "telegram", platformUserId: "1" }, secretKey(config.auth.accessSecret), 900, ms);

afterEach(async () => {
  store.clear();
  await Promise.all(apps.splice(0).map((created) => created.close()));
});

describe("отзыв токенов на маршруте чужого модуля", () => {
  it("токен, выданный до отзыва, получает 401", async () => {
    const http = await app();
    const token = await tokenIssuedAt(NOW_MS - 10_000);
    store.set(`auth:revoked-before:${ACCOUNT}`, String(Math.floor(NOW_MS / 1000)));

    const response = await http.inject({ method: "GET", url: "/api/v1/probe", headers: { authorization: `Bearer ${token}` } });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { message: "Сессия завершена — войдите заново" } });
  });

  it("без отзыва тот же токен проходит", async () => {
    const http = await app();
    const token = await tokenIssuedAt(NOW_MS - 10_000);

    const response = await http.inject({ method: "GET", url: "/api/v1/probe", headers: { authorization: `Bearer ${token}` } });

    expect(response.statusCode).toBe(200);
  });
});
