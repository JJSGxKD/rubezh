import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, Get, Global, Module, UseGuards } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { PRISMA } from "../src/infra/database.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { AuthModule } from "../src/modules/auth/auth.module.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { LaunchVerifiers } from "../src/platforms/ports/launch-verifier.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Отзыв токенов доступа на маршрутах ДРУГИХ модулей: `@UseGuards(AuthGuard)`
 * Nest собирает в модуле контроллера, а не в `AuthModule`, поэтому
 * `AccessRevocations` обязан экспортироваться — иначе необязательная
 * зависимость гарда молча пуста и отзыв не действует нигде, кроме самого
 * `AuthController`. Юнит-тесты гарда собирают его руками и этого не видят.
 */

const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
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
