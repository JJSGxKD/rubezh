import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { RedisRefreshStore } from "../src/modules/auth/redis-refresh.store.js";
import { launchFor } from "./helpers/init-data.js";

/**
 * Вход на настоящих Postgres и Redis (docs/17-testing-strategy.md §4.2).
 * Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL; без них пропускается.
 *
 * Память этого не покажет: здесь проверяется, что `upsert` действительно
 * различает заведение аккаунта и повторный вход, что пара «площадка + id»
 * уникальна на стороне базы, а не на честном слове, и что вся цепочка
 * вход → продление → выход работает на живых хранилищах.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
const live = DATABASE_URL !== "" && REDIS_URL !== "";
const BOT_TOKEN = "123456:TEST";

describe.skipIf(!live)("вход на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let service: AuthService;
  // Телеграм-идентификаторы у каждого прогона свои: файлы тестов идут
  // параллельно, и чистить таблицу аккаунтов целиком нельзя.
  const telegramId = (): number => 900_000_000 + Math.floor(Math.random() * 90_000_000);

  beforeAll(async () => {
    config = loadAppConfig({
      NODE_ENV: "test",
      DATABASE_URL,
      REDIS_URL,
      AUTH_ENABLED: "true",
      JWT_ACCESS_SECRET: randomBytes(32).toString("hex"),
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    service = new AuthService(config, new PrismaAccountRepository(prisma), new RedisRefreshStore(redis, config));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("первый вход заводит аккаунт, второй находит тот же", async () => {
    const id = telegramId();

    const first = await service.loginWithTelegram(launchFor(id, BOT_TOKEN));
    const second = await service.loginWithTelegram(launchFor(id, BOT_TOKEN));

    expect(first.account.created).toBe(true);
    expect(second.account.created).toBe(false);
    expect(second.account.accountId).toBe(first.account.accountId);
  });

  it("имя обновляется на каждом входе: игрок сменил его в Telegram", async () => {
    const id = telegramId();
    await service.loginWithTelegram(launchFor(id, BOT_TOKEN, Date.now(), "Анна"));

    const renamed = await service.loginWithTelegram(launchFor(id, BOT_TOKEN, Date.now(), "Анна Петрова"));

    expect(renamed.account.displayName).toBe("Анна Петрова");
  });

  it("пара «площадка + идентификатор» уникальна на стороне базы", async () => {
    const id = String(telegramId());
    await prisma.account.create({
      data: { accountId: randomUUID(), platform: "telegram", platformUserId: id, displayName: "Первый" },
    });

    await expect(
      prisma.account.create({
        data: { accountId: randomUUID(), platform: "telegram", platformUserId: id, displayName: "Второй" },
      }),
    ).rejects.toThrow();
  });

  it("тот же идентификатор на другой площадке — другой аккаунт", async () => {
    // Аккаунты между площадками не связываются (docs/08-web-and-identity.md §3).
    const id = String(telegramId());
    const telegram = await service.loginWithTelegram(launchFor(Number(id), BOT_TOKEN));
    const max = await prisma.account.create({
      data: { accountId: randomUUID(), platform: "max", platformUserId: id, displayName: "Тот же человек" },
    });

    expect(max.accountId).not.toBe(telegram.account.accountId);
  });

  it("вход, продление и выход проходят целиком", async () => {
    const login = await service.loginWithTelegram(launchFor(telegramId(), BOT_TOKEN));

    const renewed = await service.refreshSession(login.refreshToken);
    await service.logout(renewed.refreshToken);

    await expect(service.refreshSession(renewed.refreshToken)).rejects.toThrow();
  });
});
