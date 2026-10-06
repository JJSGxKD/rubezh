import { afterAll, beforeAll, describe } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaRateStore } from "../src/modules/fx/fx.store.js";
import { rateStoreContract } from "../../../packages/fx/test/store-contract.js";

/**
 * Хранилище курсов на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск). Тот же контракт, что проходит
 * хранилище в памяти ядра: ядро не знает про Prisma, и совместимость держит
 * тест.
 *
 * Память этого не покажет: курс в `numeric(80, 50)` без потери знаков,
 * массив источников, снимок в JSON и обратно через схему.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("хранилище курсов на живом Postgres", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Курс валюты — один на базу, поэтому каждый случай начинается с пустых
  // таблиц курсов. Другие тесты их не трогают.
  rateStoreContract(async () => {
    await prisma.$executeRaw`TRUNCATE fx_quote, fx_rate_current, fx_rate_history, fx_manual_rate, fx_snapshot, fx_source_state`;
    return { store: new PrismaRateStore(prisma), source: (name) => name };
  });
});
