import type { LeaderboardStore } from "./leaderboard.store.js";
import { DIFFICULTIES } from "./run-rules.js";
import type { RunsRepository } from "./runs.repository.js";

/**
 * Пересобрать рейтинг из базы (docs/34-stage3-plan.md, Р4). Проекция в Redis —
 * кеш: потерялась или разошлась с базой — эта функция возвращает её к
 * источнику истины. Отдельной функцией, а не методом сервиса: команде
 * пересборки не нужны ни роли, ни конфигурация антифрода, и тащить их ради
 * одного вызова незачем.
 *
 * Те, кому рейтинг сейчас закрыт (`excluded`, docs/35-stage4-plan.md WP44),
 * в доски не попадают: их прежние рейтинговые забеги лежат в базе и вернутся,
 * когда ограничение снимут.
 *
 * Возвращает, сколько игроков оказалось в рейтинге каждой сложности.
 */
export async function rebuildLeaderboard(runs: RunsRepository, leaderboard: LeaderboardStore, excluded: ReadonlySet<string>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const difficulty of DIFFICULTIES) {
    const entries = (await runs.bestTimes(difficulty)).filter((entry) => !excluded.has(entry.accountId));
    await leaderboard.replace(difficulty, entries);
    counts[difficulty] = entries.length;
  }
  return counts;
}
