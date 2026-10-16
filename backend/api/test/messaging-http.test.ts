import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Global, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { MessagingController } from "../src/modules/messaging/messaging.controller.js";
import { MessagingService } from "../src/modules/messaging/messaging.service.js";
import type { MessagingState } from "../src/modules/messaging/messaging.repository.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Можно ли боту писать игроку — для клиента (`GET /api/v1/me/messaging`,
 * tasks/T-0010): карточка «Разрешить сообщения от бота» и пункт в настройках
 * показываются, только пока разрешения нет. Состояние читает сервис модуля,
 * HTTP — настоящий Fastify.
 */

const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
const ACCOUNT = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f60";

let current: MessagingState | null = null;

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useValue: config },
    // eval падает — лимит частоты уходит на память процесса, как в http-app.test.ts
    { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("no eval")) } },
    RateLimiter,
  ],
  exports: [APP_CONFIG, REDIS, RateLimiter],
})
class InfraStub {}

@Module({
  imports: [InfraStub],
  controllers: [MessagingController],
  providers: [AuthGuard, { provide: MessagingService, useValue: { state: async () => current } }],
})
class TestModule {}

const apps: NestFastifyApplication[] = [];

async function app(): Promise<NestFastifyApplication> {
  const created = await createHttpApp(TestModule, { logger: false });
  await created.init();
  await created.getHttpAdapter().getInstance().ready();
  apps.push(created);
  return created;
}

const token = (): Promise<string> => signAccessToken({ accountId: ACCOUNT, platform: "telegram", platformUserId: "1" }, secretKey(config.auth.accessSecret), 900, Date.now());

afterEach(async () => {
  current = null;
  await Promise.all(apps.splice(0).map((created) => created.close()));
});

describe("GET /api/v1/me/messaging", () => {
  it("без токена — 401", async () => {
    const http = await app();
    const response = await http.inject({ method: "GET", url: "/api/v1/me/messaging" });
    expect(response.statusCode).toBe(401);
  });

  it("состояния нет — писать нельзя", async () => {
    const http = await app();
    const response = await http.inject({ method: "GET", url: "/api/v1/me/messaging", headers: { authorization: `Bearer ${await token()}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { canMessage: false } });
  });

  it("состояние «можно» — canMessage: true, причина и время наружу не идут", async () => {
    current = { canMessage: true, reason: "allowed", changedAt: new Date("2026-10-10T10:00:00Z") };
    const http = await app();
    const response = await http.inject({ method: "GET", url: "/api/v1/me/messaging", headers: { authorization: `Bearer ${await token()}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { canMessage: true } });
  });

  it("заблокировал бота — canMessage: false", async () => {
    current = { canMessage: false, reason: "blocked", changedAt: new Date("2026-10-10T10:00:00Z") };
    const http = await app();
    const response = await http.inject({ method: "GET", url: "/api/v1/me/messaging", headers: { authorization: `Bearer ${await token()}` } });
    expect(response.json()).toEqual({ data: { canMessage: false } });
  });
});
