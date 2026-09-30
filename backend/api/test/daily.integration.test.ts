import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaDailyRepository } from "../src/modules/daily/daily.repository.js";

/**
 * Награда дня на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): граница суток — полночь по Москве,
 * посчитанная базой, и одна отметка дня под гонкой.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("награда дня на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaDailyRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(780_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "День", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaDailyRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сутки — московские: 23:59 и 00:01 по Москве — разные дни, 00:01 и 23:59 — один", async () => {
    const me = await account();
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 1));
    const nextLateEvening = new Date(Date.UTC(2026, 9, 1, 20, 59));

    expect(await repository.state(me, lateEvening)).toEqual({ claimedDays: 0, claimedToday: false });
    expect(await repository.advance(me, 0, lateEvening)).toBe(true);
    expect(await repository.state(me, lateEvening)).toEqual({ claimedDays: 1, claimedToday: true });

    expect(await repository.state(me, afterMidnight)).toEqual({ claimedDays: 1, claimedToday: false });
    expect(await repository.advance(me, 1, afterMidnight)).toBe(true);
    expect(await repository.advance(me, 2, nextLateEvening)).toBe(false);
  });

  it("под гонкой день отмечается один раз — и первый, и следующий", async () => {
    const me = await account();
    const day = new Date(Date.UTC(2026, 8, 30, 9));
    const first = await Promise.all(Array.from({ length: 6 }, () => repository.advance(me, 0, day)));
    expect(first.filter(Boolean)).toHaveLength(1);

    const next = new Date(day.getTime() + 24 * 3_600_000);
    const second = await Promise.all(Array.from({ length: 6 }, () => repository.advance(me, 1, next)));
    expect(second.filter(Boolean)).toHaveLength(1);
    expect(await repository.state(me, next)).toEqual({ claimedDays: 2, claimedToday: true });
  });

  it("отметка с устаревшим числом дней не проходит", async () => {
    const me = await account();
    const day = new Date(Date.UTC(2026, 8, 30, 9));
    await repository.advance(me, 0, day);
    expect(await repository.advance(me, 0, new Date(day.getTime() + 24 * 3_600_000))).toBe(false);
    expect(await repository.advance(me, 5, new Date(day.getTime() + 24 * 3_600_000))).toBe(false);
  });
});
