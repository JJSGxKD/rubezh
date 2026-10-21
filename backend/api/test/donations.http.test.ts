import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { DonationsController } from "../src/modules/donations/donations.controller.js";
import type { DonationsRepository } from "../src/modules/donations/donations.repository.js";
import { DonationsService } from "../src/modules/donations/donations.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { switchesOf } from "./helpers/notify-targets.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Маршруты доната по HTTP (tasks/T-0157): вход по токену, форма тела, лимит
 * заказов и поведение при выключенной оплате. Суммы, ссылки и знак проверяет
 * `donations.test.ts`.
 */

const NOW = Date.UTC(2026, 9, 19, 9);

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

const noSupporters: DonationsRepository = {
  isSupporter: async () => false,
  markSupporter: async () => undefined,
  clearSupporterUnlessOther: async () => true,
};

describe("донаты по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(settings: AppConfig = config()) {
    const purchases = new MemoryPurchasesRepository();
    const api = new FakeStarsApi();
    const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), starsProviders(api), switchesOf(settings));
    const donations = new DonationsService(payments, new PurchaseFulfillment(), new PurchaseRevocation(), noSupporters, restrictionsGate(new MemoryRestrictionsRepository()), panelSettings());

    @Module({
      controllers: [DonationsController],
      providers: [{ provide: APP_CONFIG, useValue: config() }, { provide: REDIS, useValue: unavailableRedis }, { provide: DonationsService, useValue: donations }, RateLimiter, AuthGuard],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: randomUUID(), platform: "telegram", platformUserId: "555000444" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, NOW + 1e12);
    return { app, api, purchases, headers: { authorization: `Bearer ${token}` } };
  }

  it("без токена — 401 и у вида, и у заказа", async () => {
    const { app: server } = await start();
    expect((await server.inject({ method: "GET", url: "/api/v1/donations" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/v1/donations/orders", payload: { amount: 50 } })).statusCode).toBe(401);
  });

  it("вид доната — 200: пределы способа, готовые суммы и знак; заказ — 200 со счётом на сумму", async () => {
    const { app: server, api, headers } = await start();

    const view = await server.inject({ method: "GET", url: "/api/v1/donations", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: unknown }>().data).toEqual({ stars: { min: 1, max: 10_000, presets: [50, 100, 250, 500, 1000], mode: "live" }, tribute: null, supporter: false });

    const order = await server.inject({ method: "POST", url: "/api/v1/donations/orders", headers, payload: { amount: 77 } });
    expect(order.statusCode).toBe(200);
    expect(order.json<{ data: unknown }>().data).toMatchObject({ sku: "donation", status: "pending", priceStars: 77, chargedStars: 77, mode: "live", invoiceUrl: expect.stringContaining("https://") });
    expect(api.sent.at(-1)).toMatchObject({ stars: 77 });
  });

  it("тело без amount, со строкой, с дробью, с лишним полем и сумма вне пределов — 400, счёта нет", async () => {
    const { app: server, api, purchases, headers } = await start();
    for (const payload of [{}, { amount: "50" }, { amount: 1.5 }, { amount: null }, { amount: 50, stars: 1 }, { amount: 0 }, { amount: -5 }, { amount: 10_001 }]) {
      const response = await server.inject({ method: "POST", url: "/api/v1/donations/orders", headers, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ error: { code: string; message: string } }>().error).toEqual({ code: "validation_failed", message: "Некорректная сумма" });
    }
    expect(purchases.rows.size).toBe(0);
    expect(api.sent).toEqual([]);
  });

  it("лимит заказов: после тридцати в час — 429", async () => {
    const { app: server, headers } = await start();
    for (let index = 0; index < 30; index++) {
      const response = await server.inject({ method: "POST", url: "/api/v1/donations/orders", headers, payload: { amount: 50 } });
      expect(response.statusCode, `заказ ${String(index + 1)}`).toBe(200);
    }
    const limited = await server.inject({ method: "POST", url: "/api/v1/donations/orders", headers, payload: { amount: 50 } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
  });

  it("оплата выключена: заказ — 404 endpoint_disabled, вид — 200 без звёздной части", async () => {
    const { app: server, headers } = await start(config({ PAYMENTS_ENABLED: "false" }));

    const order = await server.inject({ method: "POST", url: "/api/v1/donations/orders", headers, payload: { amount: 50 } });
    expect(order.statusCode).toBe(404);
    expect(order.json<{ error: { code: string } }>().error.code).toBe("endpoint_disabled");

    const view = await server.inject({ method: "GET", url: "/api/v1/donations", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { stars: unknown } }>().data.stars).toBeNull();
  });
});
