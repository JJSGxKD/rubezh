import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { SECRETS } from "../src/modules/secrets/secret-catalog.js";
import { PrismaSecretsRepository } from "../src/modules/secrets/secrets.repository.js";
import { SecretsService } from "../src/modules/secrets/secrets.service.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Ключи интеграций на живых Postgres и Redis: шифртекст переживает
 * `bytea` без порчи, запись на одной реплике другая узнаёт по сообщению, а
 * строку не того шифра база не принимает. Без базы и Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 4);
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const VALUE = "CG-IntegrationValue42";

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("ключи интеграций на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  const clients: Redis[] = [];
  const replicas: SecretsService[] = [];

  const replica = async (): Promise<SecretsService> => {
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    clients.push(redis);
    const service = new SecretsService(config, new PrismaSecretsRepository(prisma), redis);
    await service.onModuleInit();
    replicas.push(service);
    return service;
  };

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL, SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    await prisma.integrationSecret.deleteMany({ where: { key: SECRETS.coingeckoDemo.key } });
  });

  afterAll(async () => {
    for (const service of replicas) service.onModuleDestroy();
    await prisma.integrationSecret.deleteMany({ where: { key: SECRETS.coingeckoDemo.key } });
    await prisma.$disconnect();
    for (const redis of clients) redis.disconnect();
  });

  it("запись на одной реплике видна другой сразу, в базе — шифртекст, сброс — тоже виден", async () => {
    const first = await replica();
    const second = await replica();
    expect(second.get(SECRETS.coingeckoDemo)).toBeNull();

    await first.write(SECRETS.coingeckoDemo, VALUE, ACTOR_ID);
    await expect.poll(() => second.get(SECRETS.coingeckoDemo), { timeout: 3_000 }).toBe(VALUE);

    const row = await prisma.integrationSecret.findUniqueOrThrow({ where: { key: SECRETS.coingeckoDemo.key } });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain("Integration");
    expect(row).toMatchObject({ updatedBy: ACTOR_ID });
    expect(row.iv).toHaveLength(12);
    expect(row.authTag).toHaveLength(16);

    expect(await first.clear(SECRETS.coingeckoDemo)).toBe(true);
    await expect.poll(() => second.get(SECRETS.coingeckoDemo), { timeout: 3_000 }).toBeNull();
  });

  it("строку не того шифра база не принимает", async () => {
    await expect(
      prisma.integrationSecret.create({
        data: { key: SECRETS.coingeckoDemo.key, keyId: "x", iv: new Uint8Array(8), authTag: new Uint8Array(16), ciphertext: new Uint8Array(4) },
      }),
    ).rejects.toThrow();
  });
});
