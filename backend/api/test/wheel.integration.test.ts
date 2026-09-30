import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaWheelRepository } from "../src/modules/wheel/wheel.repository.js";

/**
 * Крутки колеса на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): граница суток — полночь по Москве,
 * посчитанная базой, одна бесплатная крутка суток под гонкой и частичный
 * индекс, который это держит.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const SPIN = { sector: 2, resource: "coins", amount: 100 } as const;

describe.skipIf(DATABASE_URL === "")("колесо на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaWheelRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(870_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Колесо", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaWheelRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сутки — московские: 23:59 и 00:01 по Москве — разные, крутка ждёт отметки начисления", async () => {
    const me = await account();
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 1));

    expect(await repository.freeToday(me, lateEvening)).toBeNull();
    const spin = await repository.insertFree(me, SPIN, lateEvening);
    expect(spin).toMatchObject({ ...SPIN, granted: false });
    expect(await repository.insertFree(me, { ...SPIN, sector: 5 }, lateEvening)).toBeNull();
    expect(await repository.freeToday(me, lateEvening)).toEqual(spin);

    await repository.markGranted(spin?.spinId ?? "", lateEvening);
    await repository.markGranted(spin?.spinId ?? "", afterMidnight);
    expect(await repository.freeToday(me, lateEvening)).toMatchObject({ granted: true });
    const [row] = await prisma.$queryRaw<{ granted_at: Date }[]>`SELECT granted_at FROM wheel_spin WHERE spin_id = ${spin?.spinId ?? ""}::uuid`;
    expect(row?.granted_at).toEqual(lateEvening);

    expect(await repository.freeToday(me, afterMidnight)).toBeNull();
    expect(await repository.insertFree(me, SPIN, afterMidnight)).not.toBeNull();
  });

  it("шесть круток разом — записана одна", async () => {
    const me = await account();
    const at = new Date(Date.UTC(2026, 8, 30, 9));
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => repository.insertFree(me, { ...SPIN, sector: index }, at)));
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM wheel_spin WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(1);
  });

  it("ключ суток — только у бесплатной крутки: за рекламу крутят чаще раза в сутки", async () => {
    const me = await account();
    const at = new Date(Date.UTC(2026, 8, 30, 9));
    await repository.insertFree(me, SPIN, at);
    for (let spin = 0; spin < 2; spin++) {
      await prisma.$executeRaw`
        INSERT INTO wheel_spin (spin_id, account_id, source, game_day, sector, resource, amount, created_at)
        VALUES (gen_random_uuid(), ${me}::uuid, 'ad', '2026-09-30', 1, 'coins', 50, ${at})`;
    }
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM wheel_spin WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(3);
  });

  it("пустой сектор база не примет: ноль монет — ошибка в числах, а не выигрыш", async () => {
    const me = await account();
    await expect(repository.insertFree(me, { ...SPIN, amount: 0 }, new Date())).rejects.toThrow();
    await expect(repository.insertFree(me, { ...SPIN, sector: -1 }, new Date())).rejects.toThrow();
  });

  it("крутка суток ищется по частичному индексу, а не просмотром таблицы", async () => {
    const me = await account();
    const at = new Date(Date.UTC(2026, 8, 30, 9));
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return await tx.$queryRaw<{ "QUERY PLAN": string }[]>`
        EXPLAIN SELECT spin_id FROM wheel_spin
        WHERE account_id = ${me}::uuid AND source = 'free' AND game_day = (${at}::timestamptz AT TIME ZONE 'Europe/Moscow')::date`;
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("wheel_spin_free_day_key");
  });

  it("удалённый аккаунт уносит свои крутки", async () => {
    const me = await account();
    await repository.insertFree(me, SPIN, new Date());
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM wheel_spin WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(0);
  });
});
