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
 * Возвращает, сколько игроков оказалось в рейтинге каждой сложности.
 */
export async function rebuildLeaderboard(runs: RunsRepository, leaderboard: LeaderboardStore): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const difficulty of DIFFICULTIES) {
    const entries = await runs.bestTimes(difficulty);
    await leaderboard.replace(difficulty, entries);
    counts[difficulty] = entries.length;
  }
  return counts;
}
