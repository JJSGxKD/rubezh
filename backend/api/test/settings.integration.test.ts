import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { PrismaSettingsRepository } from "../src/modules/settings/settings.repository.js";
import { SettingsService } from "../src/modules/settings/settings.service.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Настройки на живых Postgres и Redis: две реплики на одной базе, запись на
 * одной — другая узнаёт по сообщению сразу, а не через минуту перечитывания;
 * сброс возвращает окружение на обеих. Без базы и Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 4);
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("настройки на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  const clients: Redis[] = [];
  const replicas: SettingsService[] = [];

  const replica = async (): Promise<SettingsService> => {
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    clients.push(redis);
    const service = new SettingsService(config, new PrismaSettingsRepository(prisma), redis);
    await service.onModuleInit();
    replicas.push(service);
    return service;
  };

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL, ADMIN_NOTIFY_REPORTS: "true" } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    await prisma.appSetting.deleteMany({ where: { key: SETTINGS.notifyReports.key } });
  });

  afterAll(async () => {
    for (const service of replicas) service.onModuleDestroy();
    await prisma.appSetting.deleteMany({ where: { key: SETTINGS.notifyReports.key } });
    await prisma.$disconnect();
    for (const redis of clients) redis.disconnect();
  });

  it("запись на одной реплике видна другой сразу, сброс — тоже", async () => {
    const first = await replica();
    const second = await replica();
    expect(second.get(SETTINGS.notifyReports)).toBe(true);

    await first.write(SETTINGS.notifyReports, false, ACTOR_ID);
    await expect.poll(() => second.get(SETTINGS.notifyReports), { timeout: 3_000 }).toBe(false);
    expect(second.describe().find((state) => state.setting.key === SETTINGS.notifyReports.key)).toMatchObject({ source: "base", updatedBy: ACTOR_ID });

    expect(await first.clear(SETTINGS.notifyReports)).toBe(true);
    await expect.poll(() => second.get(SETTINGS.notifyReports), { timeout: 3_000 }).toBe(true);
    expect(second.describe().find((state) => state.setting.key === SETTINGS.notifyReports.key)?.source).toBe("env");
  });

  it("реплика, поднятая после записи, читает её со старта", async () => {
    const first = await replica();
    await first.write(SETTINGS.notifyReports, false, ACTOR_ID);
    const late = await replica();
    expect(late.get(SETTINGS.notifyReports)).toBe(false);
    await first.clear(SETTINGS.notifyReports);
  });
});
