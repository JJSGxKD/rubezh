import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaFlagsRepository } from "../src/modules/flags/flags.repository.js";

/** Флаги на живом Postgres: площадки массивом, доля — в пределах, удаление. Без базы — пропуск. */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("флаги на живом Postgres", () => {
  let prisma: PrismaClient;
  let flags: PrismaFlagsRepository;
  const key = `test.flag-${Date.now().toString(36)}`;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    flags = new PrismaFlagsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сохранение, повторное сохранение, список и удаление", async () => {
    await flags.save({ key, enabled: true, platforms: ["telegram", "vk"], percent: 25, note: "проба", updatedBy: "00000000-0000-4000-8000-000000000001" });
    await flags.save({ key, enabled: false, platforms: [], percent: 50, note: null, updatedBy: "00000000-0000-4000-8000-000000000001" });
    expect(await flags.byKey(key)).toMatchObject({ enabled: false, platforms: [], percent: 50, note: null });
    expect((await flags.all()).some((flag) => flag.key === key)).toBe(true);
    await expect(flags.save({ key, enabled: true, platforms: [], percent: 150, note: null, updatedBy: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow();
    expect(await flags.remove(key)).toBe(true);
    expect(await flags.remove(key)).toBe(false);
  });
});
