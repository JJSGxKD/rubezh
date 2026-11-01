import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { closeRedis, createRedis } from "../infra/redis.js";
import { AccountRestrictions } from "../modules/restrictions/account-restrictions.js";
import { PrismaRestrictionsRepository } from "../modules/restrictions/restrictions.repository.js";
import { formatBoardCounts, rebuildForRestrictions } from "../modules/runs/leaderboard-rebuild.js";
import { RedisLeaderboardStore } from "../modules/runs/leaderboard.store.js";
import { PrismaRunsRepository } from "../modules/runs/runs.repository.js";

/**
 * Пересобрать рейтинг из базы (docs/34-stage3-plan.md, Р4): после потери
 * Redis или если проекция разошлась с таблицей `run`.
 *
 *   pnpm --filter backend-api runs:rebuild-leaderboard
 *
 * В контейнере — `node dist/cli/runs-rebuild-leaderboard.js`. Безопасно
 * повторять: рейтинг собирается во временный ключ и подменяет рабочий одной
 * командой, игроки не видят пустого рейтинга ни в какой момент. Те, кому
 * рейтинг сейчас закрыт ограничением, в доски не возвращаются; доски две —
 * полная и общая (docs/14-scalability.md, T-0113), аккаунты с отдельной
 * доской лежат только в полной.
 *
 * При выкате T-0113 команду запускают до первого наложения «Отдельной доски»:
 * она наполняет полную доску, которой раньше не было.
 */
async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  const redis = createRedis(config);
  try {
    await redis.connect();
    const restrictions = new AccountRestrictions(new PrismaRestrictionsRepository(prisma), redis, config);
    const counts = await rebuildForRestrictions(new PrismaRunsRepository(prisma), new RedisLeaderboardStore(redis), restrictions);
    console.log(`рейтинг пересобран: ${formatBoardCounts(counts)}`);
  } finally {
    await prisma.$disconnect();
    await closeRedis(redis);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
