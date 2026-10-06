import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { TestNoticeController } from "../src/modules/test-notice/test-notice.controller.js";
import type { TestNoticeAcceptance, TestNoticeRepository } from "../src/modules/test-notice/test-notice.repository.js";
import { TestNoticeService } from "../src/modules/test-notice/test-notice.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Предупреждение об открытом тесте (docs/35-stage4-plan.md Р59, WP33):
 * принятие — на аккаунт, новая версия текста показывается заново, старая
 * после новой ничего не откатывает, а первое принятие не переписывается.
 */

const ME = "00000000-0000-4000-8000-0000000a0001";
const T0 = new Date(Date.UTC(2026, 8, 30, 9));

class MemoryNotice implements TestNoticeRepository {
  readonly rows = new Map<string, TestNoticeAcceptance>();

  async find(accountId: string): Promise<TestNoticeAcceptance | null> {
    return this.rows.get(accountId) ?? null;
  }

  async accept(accountId: string, version: number, at: Date): Promise<TestNoticeAcceptance> {
    const row = this.rows.get(accountId);
    const next =
      row === undefined
        ? { version, acceptedAt: at, firstAcceptedAt: at }
        : version > row.version
          ? { ...row, version, acceptedAt: at }
          : row;
    this.rows.set(accountId, next);
    return next;
  }
}

describe("предупреждение о тесте", () => {
  it("не принимал — версии нет; принял — версия на аккаунт", async () => {
    const service = new TestNoticeService(new MemoryNotice());
    expect(await service.view(ME)).toEqual({ acceptedVersion: null });
    expect(await service.accept(ME, 1, T0)).toEqual({ acceptedVersion: 1 });
    expect(await service.view(ME)).toEqual({ acceptedVersion: 1 });
  });

  it("новая версия текста растит принятие, старая после новой его не откатывает, первое принятие остаётся", async () => {
    const repository = new MemoryNotice();
    const service = new TestNoticeService(repository);
    await service.accept(ME, 1, T0);
    await service.accept(ME, 2, new Date(T0.getTime() + 60_000));
    expect(await service.accept(ME, 1, new Date(T0.getTime() + 120_000))).toEqual({ acceptedVersion: 2 });
    expect(await service.acceptance(ME)).toEqual({ version: 2, acceptedAt: new Date(T0.getTime() + 60_000), firstAcceptedAt: T0 });
  });
});

describe("предупреждение о тесте по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401; кривая версия — 400; принятие — своему аккаунту", async () => {
    const repository = new MemoryNotice();
    @Module({
      controllers: [TestNoticeController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: TestNoticeService, useValue: new TestNoticeService(repository) },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/me/test-notice" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/me/test-notice", headers })).json<{ data: unknown }>().data).toEqual({ acceptedVersion: null });

    for (const payload of [{}, { version: 0 }, { version: 1.5 }, { version: "1" }, { version: 1, extra: true }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/me/test-notice", headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }

    const accepted = await app.inject({ method: "POST", url: "/api/v1/me/test-notice", headers, payload: { version: 1 } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ data: unknown }>().data).toEqual({ acceptedVersion: 1 });
    expect(repository.rows.has(ME)).toBe(true);
  });
});
