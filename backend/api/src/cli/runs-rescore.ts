import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { closeRedis, createRedis } from "../infra/redis.js";
import { BundledExpectedTable } from "../modules/rating/expected-table.js";
import { PrismaRunScoresRepository } from "../modules/rating/run-scores.repository.js";
import { RunScorer } from "../modules/rating/run-scorer.service.js";
import { rescoreRuns } from "../modules/rating/runs-rescore.js";
import { PrismaSettingsRepository } from "../modules/settings/settings.repository.js";
import { SettingsService } from "../modules/settings/settings.service.js";

/** Сколько забегов читать и писать за раз. */
const BATCH_SIZE = 500;

/**
 * Пересчитать очки эффективности прошлых забегов (tasks/T-0293, Р152): после
 * правки весов, показателя Стойкости или таблицы ожидаемого.
 *
 *   pnpm --filter backend-api runs:rescore [--since 2026-10-26]
 *
 * В контейнере — `node dist/cli/runs-rescore.js`. Считает по сохранённым
 * колонкам строки забега пачками по 500, ключи `rating.*` читает из панели.
 * Безопасно повторять: очки — функция строки и настроек, второй прогон с теми
 * же настройками записывает те же числа. Вердикт, рейтинг и доски не трогает.
 * Без `--since` пересчитываются все рейтинговые забеги.
 */
async function main(): Promise<void> {
  const since = sinceOf(process.argv.slice(2));
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  const redis = createRedis(config);
  try {
    await redis.connect();
    // Ключи очков лежат в настройках панели, а не в окружении: читаем их из базы, как другие команды.
    const settings = new SettingsService(config, new PrismaSettingsRepository(prisma), redis);
    await settings.refresh();
    const scorer = new RunScorer(new BundledExpectedTable(), settings, null);
    const report = await rescoreRuns(new PrismaRunScoresRepository(prisma), scorer, {
      since,
      batchSize: BATCH_SIZE,
      log: (message) => console.log(message),
    });
    console.log(`с даты: ${since === null ? "все забеги" : since.toISOString().slice(0, 10)}`);
    console.log(`просмотрено: ${String(report.scanned)}, пересчитано: ${String(report.rescored)}, не удалось: ${String(report.unscored)}`);
    if (report.unscored > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await closeRedis(redis);
  }
}

/** `--since 2026-10-26` или `--since 20261026`; нет флага — все забеги. */
function sinceOf(args: readonly string[]): Date | null {
  const index = args.indexOf("--since");
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined) throw new Error("После --since нужна дата: 2026-10-26");
  const normalized = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error("Дата в виде 2026-10-26 или 20261026");
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("Дата в виде 2026-10-26 или 20261026");
  return date;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
