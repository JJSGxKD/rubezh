import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { PrismaRunAdContinuesRepository } from "../src/modules/runs/run-ad-continues.repository.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";

/**
 * Второй шанс за рекламу на настоящем Postgres (docs/35-stage4-plan.md
 * WP11). Память этого не покажет: один номер продолжения и одна сессия
 * держатся уникальными ключами базы, начало игровых суток считает база, а
 * предварительная проверка оплаты видит продолжение, взятое за рекламу,
 * одним запросом вместе с покупкой.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("второй шанс за рекламу на живом Postgres", () => {
  let prisma: PrismaClient;
  let continues: PrismaRunAdContinuesRepository;
  let purchases: PrismaPurchasesRepository;
  let runs: PrismaRunsRepository;
  let accounts: PrismaAccountRepository;

  async function startedRun(): Promise<{ accountId: string; runId: string }> {
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Стрелок", username: null, photoUrl: null },
      Date.now(),
    );
    const runId = randomUUID();
    await runs.start({ runId, accountId: account.accountId, difficulty: "normal", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
    return { accountId: account.accountId, runId };
  }

  const session = () => randomUUID().replace(/-/g, "").slice(0, 16);

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    continues = new PrismaRunAdContinuesRepository(prisma);
    purchases = new PrismaPurchasesRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("номер продолжения и сессия — по одному разу; повтор той же сессии — «повтор», а не ошибка", async () => {
    const { accountId, runId } = await startedRun();
    const sessionId = session();
    const grant = { runId, continueNo: 1, accountId, sessionId, networkKey: "adsgram", grantedAt: new Date() };

    expect(await continues.grant(grant)).toBe("granted");
    expect(await continues.grant(grant)).toBe("repeat");
    expect(await continues.grant({ ...grant, sessionId: session() })).toBe("taken");
    const other = await startedRun();
    expect(await continues.grant({ ...grant, runId: other.runId, accountId: other.accountId })).toBe("taken");

    expect(await continues.bySession(sessionId)).toEqual({ runId, continueNo: 1 });
    expect(await continues.bySession(session())).toBeNull();
    expect(await continues.numbers(runId)).toEqual([1]);
  });

  it("суточный счёт — с полуночи по Москве", async () => {
    const { accountId, runId } = await startedRun();
    const second = await startedRun();
    // 30.09.2026: 23:30 и 00:30 следующих суток по Москве.
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 30));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 30));
    await continues.grant({ runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: lateEvening });
    await prisma.run.update({ where: { runId: second.runId }, data: { accountId } });
    await continues.grant({ runId: second.runId, continueNo: 1, accountId, sessionId: session(), networkKey: "vip", grantedAt: afterMidnight });

    expect(await continues.todayCount(accountId, lateEvening)).toBe(1);
    expect(await continues.todayCount(accountId, afterMidnight)).toBe(1);
    expect(await continues.todayCount(accountId, new Date(afterMidnight.getTime() + 60_000))).toBe(1);
  });

  it("счёт за продолжение, уже взятое за рекламу, проверка оплаты видит взятым", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice({
      purchaseId: randomUUID(),
      accountId,
      runId,
      continueNo: 1,
      elapsedSec: 125,
      priceStars: 3,
      chargedStars: 3,
      mode: "live",
      invoicedAt: new Date(),
    });
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    await expect(purchases.checkout(opened.purchase.purchaseId)).resolves.toMatchObject({ runFinished: false, continueTaken: false });
    await continues.grant({ runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: new Date() });
    await expect(purchases.checkout(opened.purchase.purchaseId)).resolves.toMatchObject({ continueTaken: true });
  });
});
