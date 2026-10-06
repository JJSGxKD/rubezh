import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaMessagingRepository } from "../src/modules/messaging/messaging.repository.js";

/**
 * «Можно писать» на живом Postgres (адрес — TEST_DATABASE_URL, без него
 * пропуск): порядок решает условие в `ON CONFLICT … WHERE`, и только база
 * скажет, что опоздавшее старое событие не перебивает новое.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 25, 9, 0, 0);

describe.skipIf(DATABASE_URL === "")("«можно писать» на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let messaging: PrismaMessagingRepository;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ DATABASE_URL }));
    accounts = new PrismaAccountRepository(prisma);
    messaging = new PrismaMessagingRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("побеждает более позднее событие, а не последнее пришедшее", async () => {
    const { accountId } = await accounts.upsert(
      { platform: "telegram", platformUserId: String(720_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Путник", username: null },
      Date.now(),
    );
    await messaging.set(accountId, { canMessage: false, reason: "blocked", changedAt: new Date(T0 + HOUR) });
    await messaging.set(accountId, { canMessage: true, reason: "entered", changedAt: new Date(T0) });
    expect(await messaging.get(accountId)).toEqual({ canMessage: false, reason: "blocked", changedAt: new Date(T0 + HOUR) });

    await messaging.set(accountId, { canMessage: true, reason: "unblocked", changedAt: new Date(T0 + 2 * HOUR) });
    expect(await messaging.get(accountId)).toMatchObject({ canMessage: true, reason: "unblocked" });
  });
});
