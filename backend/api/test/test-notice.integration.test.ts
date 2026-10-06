import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaTestNoticeRepository } from "../src/modules/test-notice/test-notice.repository.js";

/**
 * Принятие предупреждения о тесте на живом Postgres (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск): строка на аккаунт,
 * версия только растёт, первое принятие не переписывается и под гонкой.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const T0 = new Date(Date.UTC(2026, 8, 30, 9));
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);

describe.skipIf(DATABASE_URL === "")("предупреждение о тесте на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaTestNoticeRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(990_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Тест", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaTestNoticeRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("версия только растёт, первое принятие остаётся первым", async () => {
    const me = await account();
    expect(await repository.find(me)).toBeNull();
    expect(await repository.accept(me, 1, T0)).toEqual({ version: 1, acceptedAt: T0, firstAcceptedAt: T0 });
    expect(await repository.accept(me, 1, minutes(1))).toEqual({ version: 1, acceptedAt: T0, firstAcceptedAt: T0 });
    expect(await repository.accept(me, 3, minutes(2))).toEqual({ version: 3, acceptedAt: minutes(2), firstAcceptedAt: T0 });
    expect(await repository.accept(me, 2, minutes(3))).toEqual({ version: 3, acceptedAt: minutes(2), firstAcceptedAt: T0 });
  });

  it("шесть принятий разом — одна строка", async () => {
    const me = await account();
    await Promise.all(Array.from({ length: 6 }, (_, index) => repository.accept(me, 1, minutes(index))));
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM test_notice WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(1);
  });

  it("удалённый аккаунт уносит принятие; нулевую версию база не примет", async () => {
    const me = await account();
    await expect(repository.accept(me, 0, T0)).rejects.toThrow();
    await repository.accept(me, 1, T0);
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    expect(await repository.find(me)).toBeNull();
  });
});
