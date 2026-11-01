import type { AccountRestrictions } from "../restrictions/account-restrictions.js";
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
 * Досок две (docs/35-stage4-plan.md, Р104, T-0113): полная — все рейтинговые
 * аккаунты, общая — те же без аккаунтов с отдельной доской (`separate`).
 * Те, кому рейтинг сейчас закрыт (`excluded`, WP44), не лежат ни в одной:
 * их прежние рейтинговые забеги остаются в базе и вернутся, когда
 * ограничение снимут.
 *
 * Возвращает, сколько игроков оказалось в каждой доске каждой сложности.
 */
export interface BoardCounts {
  full: number;
  common: number;
}

export async function rebuildLeaderboard(
  runs: RunsRepository,
  leaderboard: LeaderboardStore,
  excluded: ReadonlySet<string>,
  separate: ReadonlySet<string>,
): Promise<Record<string, BoardCounts>> {
  const counts: Record<string, BoardCounts> = {};
  for (const difficulty of DIFFICULTIES) {
    const full = (await runs.bestTimes(difficulty)).filter((entry) => !excluded.has(entry.accountId));
    const common = full.filter((entry) => !separate.has(entry.accountId));
    await leaderboard.replace(difficulty, "full", full);
    await leaderboard.replace(difficulty, "common", common);
    counts[difficulty] = { full: full.length, common: common.length };
  }
  return counts;
}

/**
 * Пересборка с двумя наборами исключений, которые спрашивают у ограничений
 * аккаунта: закрытый рейтинг и отдельная доска. Её зовут обе команды
 * (`runs-rebuild-leaderboard`, `wipe`), чтобы набор не разошёлся между ними.
 */
export async function rebuildForRestrictions(
  runs: RunsRepository,
  leaderboard: LeaderboardStore,
  restrictions: Pick<AccountRestrictions, "restrictedAccounts">,
): Promise<Record<string, BoardCounts>> {
  const [excluded, separate] = await Promise.all([restrictions.restrictedAccounts("leaderboard"), restrictions.restrictedAccounts("separate_board")]);
  return await rebuildLeaderboard(runs, leaderboard, new Set(excluded), new Set(separate));
}

/** «easy — полная 12, общая 11; …»: две доски по каждой сложности — для вывода команд. */
export function formatBoardCounts(counts: Record<string, BoardCounts>): string {
  return Object.entries(counts)
    .map(([difficulty, count]) => `${difficulty} — полная ${String(count.full)}, общая ${String(count.common)}`)
    .join("; ");
}
