import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaReferralsRepository } from "../src/modules/referrals/referrals.repository.js";

/** Привязки рефералов на живом Postgres: одна и навсегда, активация — один раз. Без базы — пропуск. */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("рефералка на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let referrals: PrismaReferralsRepository;

  async function account(): Promise<string> {
    const platformUserId = String(990_000_000 + Math.floor(Math.random() * 9_000_000));
    return (await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Приглашённый", username: null, photoUrl: null }, Date.now())).accountId;
  }

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    accounts = new PrismaAccountRepository(prisma);
    referrals = new PrismaReferralsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("привязка одна и навсегда, активация — один раз и засчитывается в сутки", async () => {
    const referrer = await account();
    const referred = await account();
    const other = await account();
    expect(await referrals.bind(referred, referrer, "bound", null)).toBe(true);
    expect(await referrals.bind(referred, other, "bound", null)).toBe(false);
    expect(await referrals.binding(referred)).toMatchObject({ referrerId: referrer, status: "bound", activatedAt: null });

    expect(await referrals.activate(referred, new Date())).toBe(true);
    expect(await referrals.activate(referred, new Date())).toBe(false);
    expect(await referrals.activatedToday(referrer)).toBe(1);
    expect((await referrals.byReferrer(referrer, 10))[0]).toMatchObject({ referredId: referred, status: "activated", displayName: "Приглашённый" });
  });

  it("отклонённая привязка остаётся, не активируется и не видна пригласившему", async () => {
    const referrer = await account();
    const twin = await account();
    expect(await referrals.bind(twin, referrer, "rejected", "same_network")).toBe(true);
    expect(await referrals.activate(twin, new Date())).toBe(false);
    expect(await referrals.byReferrer(referrer, 10)).toEqual([]);
    await expect(referrals.bind(referrer, referrer, "bound", null)).rejects.toThrow();
  });
});
