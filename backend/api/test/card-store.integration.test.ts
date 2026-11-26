import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { cardHashOf, CARD_STORE, RedisCardStore, type CardStore } from "../src/common/card/card-store.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { CardsController, CARD_LOOKUP_LIMIT } from "../src/modules/cards/cards.controller.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Публичный адрес картинки бота на живом Redis (tasks/T-0252; адрес —
 * PLAYTEST_TEST_REDIS_URL, без него пропуск): PNG хранится по хэшу содержимого,
 * отдаётся с вечным кэшем, а перебор адресов упирается в лимит.
 */

const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 14);

/** Минимальный PNG: подпись, дальше случайный хвост — хранилищу важны байты, а не картинка. */
function pngLike(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
}

describe.skipIf(REDIS_URL === "")("картинки бота по адресу на живом Redis", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let store: CardStore;
  let config: AppConfig;
  let ipCounter = 0;

  /** Свой адрес клиента на каждый тест: лимит считается по нему, а Redis общий между прогонами. */
  const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${(ipCounter += 1) % 250}`;

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, REDIS_URL, PUBLIC_API_URL: "https://api.example" } as NodeJS.ProcessEnv);
    redis = createRedis(config);
    await redis.connect();
    store = new RedisCardStore(redis);

    @Module({
      controllers: [CardsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: redis },
        { provide: CARD_STORE, useValue: store },
        RateLimiter,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeRedis(redis);
  });

  const get = (url: string, headers: Record<string, string> = {}, remoteAddress = freshIp()) => app.inject({ method: "GET", url, headers, remoteAddress });

  it("сохранение → GET /cards/<хэш>.png → тот же PNG с вечным кэшем", async () => {
    const png = pngLike();
    const hash = await store.save(png);
    expect(hash).toBe(cardHashOf(png));

    const response = await get(`/api/v1/cards/${hash}.png`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.equals(png)).toBe(true);
  });

  it("повторное сохранение того же PNG — тот же адрес, и срок хранения у ключа есть", async () => {
    const png = pngLike();
    const first = await store.save(png);
    const second = await store.save(png);
    expect(second).toBe(first);
    const ttl = await redis.ttl(`card:png:${first}`);
    expect(ttl).toBeGreaterThan(29 * 24 * 3600);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 3600);
  });

  it("тот же ETag во втором запросе — 304 без тела", async () => {
    const hash = await store.save(pngLike());
    const first = await get(`/api/v1/cards/${hash}.png`);
    const etag = String(first.headers.etag);
    expect(etag).toBe(`"${hash}"`);
    const again = await get(`/api/v1/cards/${hash}.png`, { "if-none-match": etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });

  it("чужой хэш и неправильное имя — 404 общей формой ошибки", async () => {
    const stranger = await get(`/api/v1/cards/${"0".repeat(64)}.png`);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toMatchObject({ error: { code: "card_not_found" } });
    for (const name of ["abc.png", `${"A".repeat(64)}.png`, `${"0".repeat(64)}.jpg`, `${"0".repeat(64)}`, "..%2F..%2Fetc%2Fpasswd"]) {
      expect((await get(`/api/v1/cards/${name}`)).statusCode, name).toBe(404);
    }
  });

  it("лимит адреса: сверх него — 429, а другой клиент не задет", async () => {
    const hash = await store.save(pngLike());
    const noisy = freshIp();
    for (let i = 0; i < CARD_LOOKUP_LIMIT.limit; i++) {
      expect((await get(`/api/v1/cards/${hash}.png`, {}, noisy)).statusCode).toBe(200);
    }
    const blocked = await get(`/api/v1/cards/${hash}.png`, {}, noisy);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await get(`/api/v1/cards/${hash}.png`)).statusCode).toBe(200);
  }, 60_000);

  it("хранилище не принимает пустое и слишком большое", async () => {
    await expect(store.save(Buffer.alloc(0))).rejects.toThrow();
    await expect(store.save(Buffer.alloc(4 * 1024 * 1024 + 1))).rejects.toThrow();
  });
});
