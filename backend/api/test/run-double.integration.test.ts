import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { PrismaRunDoubleRepository } from "../src/modules/progress/run-double.repository.js";

/**
 * Удвоение награды за забег на живом Postgres (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск): забег удваивается одной
 * сессией показа и под гонкой, чужой забег не виден, база не примет
 * удвоение без сессии.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const sessionId = () => randomBytes(12).toString("base64url");

describe.skipIf(DATABASE_URL === "")("удвоение награды на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let progress: PrismaProgressRepository;
  let repository: PrismaRunDoubleRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(900_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Удвоение", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function rewarded(accountId: string, coinsCredited: number | null = 90): Promise<string> {
    const runId = `double-it-${randomBytes(6).toString("hex")}`;
    await progress.recordRun({ runId, accountId, coins: 90, xp: 100, skipped: null, at: NOON });
    if (coinsCredited !== null) await progress.markCredited(runId, coinsCredited);
    return runId;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    progress = new PrismaProgressRepository(prisma);
    repository = new PrismaRunDoubleRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("кандидат — своя награда с монетами и временем; чужому аккаунту её нет", async () => {
    const me = await account();
    const stranger = await account();
    const runId = await rewarded(me);
    expect(await repository.candidate(runId, me)).toEqual({ runId, coinsCredited: 90, skipped: null, createdAt: NOON, doubleSessionId: null, doubledAt: null });
    expect(await repository.candidate(runId, stranger)).toBeNull();
    expect(await repository.attach(runId, stranger, sessionId())).toBe(false);
  });

  it("две сессии разом — удваивает одна; та же сессия привязывается снова, отметка — однажды", async () => {
    const me = await account();
    const runId = await rewarded(me);
    const [first, second] = [sessionId(), sessionId()];
    const results = await Promise.all([repository.attach(runId, me, first), repository.attach(runId, me, second)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? first : second;
    expect(await repository.attach(runId, me, winner)).toBe(true);

    await repository.markDoubled(runId, NOON);
    await repository.markDoubled(runId, new Date(NOON.getTime() + 60_000));
    expect(await repository.candidate(runId, me)).toMatchObject({ doubleSessionId: winner, doubledAt: NOON });
  });

  it("одна сессия — один забег; удвоение без сессии база не примет", async () => {
    const me = await account();
    const [one, two] = [await rewarded(me), await rewarded(me)];
    const session = sessionId();
    expect(await repository.attach(one, me, session)).toBe(true);
    await expect(repository.attach(two, me, session)).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE run_reward SET doubled_at = now() WHERE run_id = ${two}`).rejects.toThrow();
  });
});
