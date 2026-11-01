import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { closeRedis, createRedis } from "../infra/redis.js";
import { AccountRestrictions } from "../modules/restrictions/account-restrictions.js";
import { PrismaRestrictionsRepository } from "../modules/restrictions/restrictions.repository.js";
import { RestrictionsHooks } from "../modules/restrictions/restrictions-hooks.js";
import { RedisLeaderboardStore } from "../modules/runs/leaderboard.store.js";
import { RatingRestrictions } from "../modules/runs/rating-restrictions.js";
import { RunsHooks } from "../modules/runs/runs-hooks.js";
import { PrismaRunsRepository } from "../modules/runs/runs.repository.js";
import { RedisSeasonBoardStore } from "../modules/seasons/season-board.store.js";
import { SeasonSchedule } from "../modules/seasons/seasons-schedule.js";
import { SeasonsProjection } from "../modules/seasons/seasons-projection.js";
import { PrismaSeasonsRepository } from "../modules/seasons/seasons.repository.js";
import { PrismaSettingsRepository } from "../modules/settings/settings.repository.js";
import { SettingsService } from "../modules/settings/settings.service.js";

/**
 * Пересобрать таблицы текущей недели из базы (tasks/T-0110): после потери
 * Redis или если проекция разошлась с таблицей `run`.
 *
 *   pnpm --filter backend-api seasons:rebuild
 *
 * В контейнере — `node dist/cli/seasons-rebuild.js`. Безопасно повторять:
 * таблица собирается во временный ключ и подменяет рабочий одной командой.
 * Пока `seasons.start-date` пуст или первый сезон не начался, команда ничего
 * не делает. Закрытые сезоны не затрагиваются — их итоги лежат в базе.
 */
async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  const redis = createRedis(config);
  try {
    await redis.connect();
    // Дата старта лежит в настройках панели, а не в окружении: читаем её из базы.
    const settings = new SettingsService(config, new PrismaSettingsRepository(prisma), redis);
    await settings.refresh();
    const restrictions = new AccountRestrictions(new PrismaRestrictionsRepository(prisma), redis, config);
    // Нужны только доски аккаунта и кому отдельная доска: обход и слушатели рейтинга здесь не запускаются.
    const hooks = new RestrictionsHooks();
    const rating = new RatingRestrictions(config, redis, new PrismaRunsRepository(prisma), new RedisLeaderboardStore(redis), restrictions, hooks);
    const projection = new SeasonsProjection(new SeasonSchedule(settings), new RedisSeasonBoardStore(redis), new PrismaSeasonsRepository(prisma), new RunsHooks(), hooks, restrictions, rating);
    const counts = await projection.rebuild();
    const entries = Object.entries(counts);
    console.log(entries.length === 0 ? "сезонов сейчас нет — пересобирать нечего" : `таблицы недели пересобраны: ${entries.map(([difficulty, count]) => `${difficulty} — ${String(count)}`).join(", ")}`);
  } finally {
    await prisma.$disconnect();
    await closeRedis(redis);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
