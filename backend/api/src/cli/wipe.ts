import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { closeRedis, createRedis } from "../infra/redis.js";
import { AccountRestrictions } from "../modules/restrictions/account-restrictions.js";
import { PrismaRestrictionsRepository } from "../modules/restrictions/restrictions.repository.js";
import { rebuildLeaderboard } from "../modules/runs/leaderboard-rebuild.js";
import { RedisLeaderboardStore } from "../modules/runs/leaderboard.store.js";
import { PrismaRunsRepository } from "../modules/runs/runs.repository.js";
import { WipeUsageError, formatPlan, formatResult, parseWipeArgs, planWipe, runWipe } from "../modules/wipe/wipe-runner.js";

/**
 * Вайп перед лончем (docs/35-stage4-plan.md, Р87). Запускает человек, по шагам
 * из docs/20-env-and-ports.md §5.4 — **после бэкапа** (`./backup.sh --before-deploy wipe`):
 * из контейнера бэкапов не видно, поэтому шаг не в коде.
 *
 *   wipe                              — только подсчёт, ничего не меняется
 *   wipe --plan                       — то же
 *   wipe --run --confirm ГГГГ-ММ-ДД   — снимок и стирание; дата — сегодняшняя по UTC
 *
 * В контейнере — `node dist/cli/wipe.js …`. Снимок компенсаций и стирание —
 * одна транзакция; после неё пересобирается рейтинг (доски станут пустыми),
 * ограниченные по-прежнему в доски не возвращаются. Блокировки, сессии, лимиты
 * и кеш ограничений не трогаются.
 */
async function main(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const command = parseWipeArgs(process.argv.slice(2), today);
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  try {
    if (command.kind === "plan") {
      console.log(formatPlan(await planWipe(prisma, now), today).join("\n"));
      return;
    }
    const result = await runWipe(prisma, now);
    // Вывод — раньше пересборки рейтинга: человек сохраняет его по инструкции, даже если Redis подведёт.
    console.log(formatResult(result).join("\n"));
    const redis = createRedis(config);
    try {
      await redis.connect();
      const excluded = await new AccountRestrictions(new PrismaRestrictionsRepository(prisma), redis, config).restrictedAccounts("leaderboard");
      const counts = await rebuildLeaderboard(new PrismaRunsRepository(prisma), new RedisLeaderboardStore(redis), new Set(excluded));
      console.log(`\nрейтинг пересобран: ${Object.entries(counts).map(([difficulty, count]) => `${difficulty} — ${count}`).join(", ")}`);
    } catch (error: unknown) {
      throw new Error(`Вайп выполнен, но рейтинг не пересобран: ${error instanceof Error ? error.message : "unknown"}. Повторите: node dist/cli/runs-rebuild-leaderboard.js`, { cause: error });
    } finally {
      await closeRedis(redis);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(error instanceof WipeUsageError ? error.exitCode : 1);
});
