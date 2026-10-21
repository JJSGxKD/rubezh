import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Индекс досмотров по времени завершения на живом Postgres (tasks/T-0137,
 * docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск): ряд сводки панели берёт окно по `completed_at`, и без индекса
 * каждый опрос обходит всю таблицу показов.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("индексы ad_session на живом Postgres", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 5);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("есть индекс по completed_at в схеме тестовой базы", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'ad_session'`;

    expect(rows.some((row) => /\(completed_at\)/.test(row.indexdef))).toBe(true);
  });
});
