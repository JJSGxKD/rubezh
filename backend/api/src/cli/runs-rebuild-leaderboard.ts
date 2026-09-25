import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { closeRedis, createRedis } from "../infra/redis.js";
import { rebuildLeaderboard } from "../modules/runs/leaderboard-rebuild.js";
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
 * командой, игроки не видят пустого рейтинга ни в какой момент.
 */
async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  const redis = createRedis(config);
  try {
    await redis.connect();
    const counts = await rebuildLeaderboard(new PrismaRunsRepository(prisma), new RedisLeaderboardStore(redis));
    console.log(`рейтинг пересобран: ${Object.entries(counts).map(([difficulty, count]) => `${difficulty} — ${count}`).join(", ")}`);
  } finally {
    await prisma.$disconnect();
    await closeRedis(redis);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
