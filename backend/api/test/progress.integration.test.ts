import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { xpForLevel } from "../src/modules/progress/progress-rules.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RunRewards, type RewardJob } from "../src/modules/progress/run-rewards.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Награды за забег на живом Postgres с настоящим кошельком
 * (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск). Критерий приёмки WP4: повтор итога не удваивает награду, забег
 * с вердиктом `rejected` наград не даёт.
 *
 * Пул у теста свой, шире боевого: проверяется поведение базы под гонкой, а не
 * настройка пула (как в `wallet.integration.test.ts`).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("награды за забег на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let progress: PrismaProgressRepository;
  let rewards: RunRewards;
  let view: ProgressService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(730_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Награда", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  function job(accountId: string, patch: Partial<RewardJob> = {}): RewardJob {
    return {
      runId: randomUUID(),
      accountId,
      difficulty: "easy",
      survivalSec: 420,
      enemiesKilled: 600,
      level: 20,
      cheats: false,
      verdict: "ok",
      finishedAt: new Date().toISOString(),
      ...patch,
    };
  }

  const coins = async (accountId: string) => (await wallet.balances(accountId)).coins;
  const gems = async (accountId: string) => (await wallet.balances(accountId)).gems;

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 20, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    progress = new PrismaProgressRepository(prisma);
    rewards = new RunRewards(config, new RunsHooks(), progress, wallet);
    view = new ProgressService(progress);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("забег даёт монеты и опыт, первый же — уровень с наградой", async () => {
    const id = await account();
    const run = job(id);

    const row = await rewards.grant(run);

    // 88 монет за забег; 165 опыта — это второй уровень (150), награда за него 100 монет
    expect(row).toMatchObject({ coins: 88, coinsCredited: 88, xp: 165, levelBefore: 1, levelAfter: 2 });
    expect(await coins(id)).toBe(88 + 100);
    expect(await view.runReward(id, run.runId)).toMatchObject({ status: "granted", coins: 88, xp: 165, levelAfter: 2, progress: { level: 2, xp: 165 } });
  });

  it("повтор задания ничего не удваивает", async () => {
    const id = await account();
    const run = job(id);
    await rewards.grant(run);
    await rewards.grant(run);
    await rewards.process({ data: run });

    expect(await coins(id)).toBe(188);
    expect((await progress.progress(id)).xp).toBe(165);
  });

  it(
    "двадцать параллельных повторов одного забега — одна награда",
    async () => {
      const id = await account();
      const run = job(id);
      await Promise.all(Array.from({ length: 20 }, () => rewards.grant(run)));

      expect(await coins(id)).toBe(188);
      expect((await progress.progress(id)).xp).toBe(165);
      expect(await prisma.runReward.count({ where: { accountId: id } })).toBe(1);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "параллельные разные забеги одного игрока складывают опыт без потерь",
    async () => {
      const id = await account();
      await Promise.all(Array.from({ length: 10 }, () => rewards.grant(job(id))));
      expect((await progress.progress(id)).xp).toBe(1650);
    },
    RACE_TIMEOUT_MS,
  );

  it("переход через несколько уровней — награда за каждый, самоцветы за пятый", async () => {
    const id = await account();
    // 40 минут на лёгкой, 40-й уровень забега: 400 + 195 = 595 опыта → с 1-го до 4-го…
    await rewards.grant(job(id, { survivalSec: 2400, level: 40, enemiesKilled: 3000 }));
    let before = (await progress.progress(id)).level;
    while (before < 5) {
      await rewards.grant(job(id, { survivalSec: 2400, level: 40, enemiesKilled: 3000 }));
      before = (await progress.progress(id)).level;
    }
    expect((await progress.progress(id)).xp).toBeGreaterThanOrEqual(xpForLevel(5));
    expect(await gems(id)).toBe(10);
    const levelEntries = await prisma.walletEntry.count({ where: { accountId: id, reason: "level_reward", resource: "coins" } });
    expect(levelEntries).toBe((await progress.progress(id)).level - 1);
  });

  it("упало между опытом и монетами — повтор доначисляет монеты по тому же ключу", async () => {
    const id = await account();
    const run = job(id);
    // Первая попытка успела записать опыт и упала до кошелька.
    await progress.recordRun({ runId: run.runId, accountId: id, coins: 88, xp: 165, skipped: null, at: new Date() });
    expect(await view.runReward(id, run.runId)).toEqual({ status: "pending" });

    await rewards.grant(run);

    expect(await coins(id)).toBe(188);
    expect((await progress.progress(id)).xp).toBe(165);
  });

  it("отклонённый, с читами и короткий забег наград не дают — и говорят почему", async () => {
    const id = await account();
    const rejected = job(id, { verdict: "rejected" });
    const cheats = job(id, { cheats: true });
    const short = job(id, { survivalSec: 12 });
    for (const run of [rejected, cheats, short]) await rewards.grant(run);

    expect(await coins(id)).toBe(0);
    expect((await progress.progress(id)).xp).toBe(0);
    expect(await view.runReward(id, rejected.runId)).toEqual({ status: "none", reason: "rejected" });
    expect(await view.runReward(id, short.runId)).toEqual({ status: "none", reason: "too_short" });
  });

  it("награду чужого забега не видно", async () => {
    const owner = await account();
    const stranger = await account();
    const run = job(owner);
    await rewards.grant(run);
    expect(await view.runReward(stranger, run.runId)).toEqual({ status: "pending" });
  });
});
