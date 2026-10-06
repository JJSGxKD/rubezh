import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaFriendReturnsRepository } from "../src/modules/referrals/friend-returns.repository.js";
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
    // Активированную задним числом отклонить нельзя: награда уже начислена.
    expect(await referrals.reject(referred, "moderator")).toBe(false);
  });

  it("модератор отклоняет ожидающую привязку; счётчики по статусам", async () => {
    const referrer = await account();
    const [first, second] = await Promise.all([account(), account()]);
    await referrals.bind(first, referrer, "bound", null);
    await referrals.bind(second, referrer, "bound", null);
    expect(await referrals.reject(first, "moderator")).toBe(true);
    expect(await referrals.binding(first)).toMatchObject({ status: "rejected", rejectReason: "moderator" });
    await referrals.activate(second, new Date());
    expect(await referrals.counts(referrer)).toEqual({ bound: 0, activated: 1, rejected: 1 });
  });

  it("отклонённая привязка остаётся, не активируется и не видна пригласившему", async () => {
    const referrer = await account();
    const twin = await account();
    expect(await referrals.bind(twin, referrer, "rejected", "same_network")).toBe(true);
    expect(await referrals.activate(twin, new Date())).toBe(false);
    expect(await referrals.byReferrer(referrer, 10)).toEqual([]);
    await expect(referrals.bind(referrer, referrer, "bound", null)).rejects.toThrow();
  });

  it("возвращение: одно на пару в периоде, награда помечается один раз, старое не ждёт", async () => {
    const returns = new PrismaFriendReturnsRepository(prisma);
    const returned = await account();
    const friend = await account();
    const now = new Date();
    expect(await returns.record(returned, friend, 700, now)).toBe(true);
    expect(await returns.record(returned, friend, 700, now)).toBe(false);
    expect(await returns.pending(returned, new Date(now.getTime() - 60_000))).toEqual([{ friendId: friend, period: 700 }]);
    expect(await returns.markRewarded(returned, friend, 700, now)).toBe(true);
    expect(await returns.markRewarded(returned, friend, 700, now)).toBe(false);
    expect(await returns.pending(returned, new Date(0))).toEqual([]);

    await returns.record(returned, friend, 701, new Date(now.getTime() - 30 * 86_400_000));
    expect(await returns.pending(returned, new Date(now.getTime() - 7 * 86_400_000))).toEqual([]);
    await expect(returns.record(returned, returned, 702, now)).rejects.toThrow();
  });
});
