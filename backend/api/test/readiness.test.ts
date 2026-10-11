import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { ReadinessController } from "../src/health/readiness.controller.js";
import { createHttpApp } from "../src/http-app.js";
import { PRISMA } from "../src/infra/database.js";
import { REDIS } from "../src/infra/redis.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

// Проверка готовности (tasks/T-0033): 200 только если достаются и Postgres, и
// Redis. Хранилища подменены, HTTP — настоящий Fastify.

type Probe = () => Promise<unknown>;

const ok: Probe = async () => [{ "?column?": 1 }];
const failing: Probe = async () => Promise.reject(new Error("connection refused to 10.0.0.5:5432"));
const never: Probe = () => new Promise(() => undefined);

const apps: NestFastifyApplication[] = [];

async function appWith(postgres: Probe, redisPing: Probe): Promise<NestFastifyApplication> {
  // eval падает — лимит частоты уходит на память процесса, как в http-app.test.ts
  const redis = { eval: async () => Promise.reject(new Error("no eval")), ping: redisPing } as unknown as Redis;
  const prisma = { $queryRaw: postgres, $queryRawUnsafe: postgres };
  @Module({
    controllers: [ReadinessController],
    providers: [
      { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV }) },
      { provide: REDIS, useValue: redis },
      { provide: PRISMA, useValue: prisma },
      RateLimiter,
    ],
  })
  class TestModule {}
  const app = await createHttpApp(TestModule, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /health/ready", () => {
  it("отвечает 200, когда Postgres и Redis на связи", async () => {
    const app = await appWith(ok, async () => "PONG");
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("отвечает 503, когда Postgres бросает, и не раскрывает текст ошибки", async () => {
    const app = await appWith(failing, async () => "PONG");
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "degraded", checks: { postgres: "fail", redis: "ok" } });
    expect(response.body).not.toContain("10.0.0.5");
    expect(response.body).not.toContain("refused");
  });

  it("отвечает 503, когда Redis молчит дольше секунды", async () => {
    const app = await appWith(ok, never);
    const started = Date.now();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "degraded", checks: { postgres: "ok", redis: "fail" } });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("не требует токена доступа", async () => {
    const app = await appWith(ok, async () => "PONG");
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).not.toBe(401);
  });

  it("живёт на корне, без префикса /api/v1", async () => {
    const app = await appWith(ok, async () => "PONG");
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(404);
  });

  it("на 61-й запрос с одного адреса за минуту отвечает 429", async () => {
    const app = await appWith(ok, async () => "PONG");
    for (let i = 0; i < 60; i += 1) {
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/health/ready" });
    expect(limited.statusCode).toBe(429);
  });
});
