import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaRunAdRerollsRepository } from "../src/modules/runs/run-ad-rerolls.repository.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Рекламный переброс карточек на настоящем Postgres (tasks/T-0199). Память
 * этого не покажет: «один на забег» и «одна сессия — один забег» держатся
 * ключами таблицы, а два параллельных забора обязаны дать ровно одну запись.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("рекламный переброс карточек на живом Postgres", () => {
  let prisma: PrismaClient;
  let rerolls: PrismaRunAdRerollsRepository;
  let runs: PrismaRunsRepository;
  let accounts: PrismaAccountRepository;

  async function startedRun(accountId?: string): Promise<{ accountId: string; runId: string }> {
    const owner =
      accountId ??
      (
        await accounts.upsert(
          { platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Стрелок", username: null, photoUrl: null },
          Date.now(),
        )
      ).accountId;
    const runId = randomUUID();
    await runs.start({ runId, accountId: owner, difficulty: "hard", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
    return { accountId: owner, runId };
  }

  const session = () => randomUUID().replace(/-/g, "").slice(0, 16);

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    rerolls = new PrismaRunAdRerollsRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("забег и сессия — по одному разу; повтор той же сессии — «повтор», а не ошибка", async () => {
    const { accountId, runId } = await startedRun();
    const sessionId = session();
    const grant = { runId, accountId, sessionId, networkKey: "adsgram", grantedAt: new Date() };

    expect(await rerolls.grant(grant)).toBe("granted");
    expect(await rerolls.grant(grant)).toBe("repeat");
    // Другая сессия на тот же забег — занято: переброс один.
    expect(await rerolls.grant({ ...grant, sessionId: session() })).toBe("taken");
    // Та же сессия на другой забег — тоже занято.
    const other = await startedRun(accountId);
    expect(await rerolls.grant({ ...grant, runId: other.runId })).toBe("taken");

    expect(await rerolls.bySession(sessionId)).toEqual({ runId });
    expect(await rerolls.bySession(session())).toBeNull();
    expect(await rerolls.count(runId)).toBe(1);
    expect(await rerolls.count(other.runId)).toBe(0);
  });

  it("два параллельных забора разными сессиями на один забег дают ровно один «выдано»", async () => {
    const { accountId, runId } = await startedRun();
    const results = await Promise.all(
      [session(), session()].map((sessionId) => rerolls.grant({ runId, accountId, sessionId, networkKey: "adsgram", grantedAt: new Date() })),
    );

    expect([...results].sort()).toEqual(["granted", "taken"]);
    expect(await rerolls.count(runId)).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("одна сессия на два забега параллельно — тоже одна запись", async () => {
    const first = await startedRun();
    const second = await startedRun(first.accountId);
    const sessionId = session();
    const results = await Promise.all(
      [first, second].map(({ runId }) => rerolls.grant({ runId, accountId: first.accountId, sessionId, networkKey: "adsgram", grantedAt: new Date() })),
    );

    expect([...results].sort()).toEqual(["granted", "taken"]);
    expect((await rerolls.count(first.runId)) + (await rerolls.count(second.runId))).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("строка уходит каскадом вместе с забегом", async () => {
    const { accountId, runId } = await startedRun();
    const sessionId = session();
    await rerolls.grant({ runId, accountId, sessionId, networkKey: "vip", grantedAt: new Date() });
    expect(await rerolls.count(runId)).toBe(1);

    await prisma.run.delete({ where: { runId } });

    expect(await rerolls.count(runId)).toBe(0);
    expect(await rerolls.bySession(sessionId)).toBeNull();
  });
});
