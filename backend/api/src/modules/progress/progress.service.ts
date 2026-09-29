import { Inject, Injectable } from "@nestjs/common";
import { levelCap } from "../items/item-rules.js";
import { MAX_LEVEL, levelReward, xpForLevel, type LevelReward } from "./progress-rules.js";
import { PROGRESS_REPOSITORY, type ProgressRepository } from "./progress.repository.js";

/**
 * Что игрок видит о своём прогрессе (docs/35-stage4-plan.md, WP4): уровень,
 * сколько до следующего и что получено за забег.
 */

/**
 * Сколько ближайших уровней показывает экран уровня (Р42): цель на пару
 * вечеров, а не таблица до сотого.
 */
export const UPCOMING_LEVELS = 5;

/**
 * Что даст уровень: награда и потолок уровня предметов. Считает сервер — у
 * него правила наград и снаряжения; что уровень открывает в забеге, клиент
 * берёт из таблицы разблокировок движка.
 */
export interface UpcomingLevel extends LevelReward {
  level: number;
  itemLevelCap: number;
}

export interface ProgressView {
  level: number;
  xp: number;
  /** сколько опыта набрано внутри текущего уровня и сколько нужно на весь уровень */
  xpIntoLevel: number;
  xpForNext: number | null;
  nextReward: LevelReward | null;
  /** ближайшие уровни по порядку; на потолке — пусто */
  upcoming: UpcomingLevel[];
}

export type RunRewardView =
  /** задание очереди ещё не дошло — экран итогов спросит снова */
  | { status: "pending" }
  | { status: "none"; reason: string }
  | { status: "granted"; coins: number; coinsCapped: boolean; xp: number; levelBefore: number; levelAfter: number; progress: ProgressView };

@Injectable()
export class ProgressService {
  constructor(@Inject(PROGRESS_REPOSITORY) private readonly progress: ProgressRepository) {}

  async view(accountId: string): Promise<ProgressView> {
    return progressView(await this.progress.progress(accountId));
  }

  async runReward(accountId: string, runId: string): Promise<RunRewardView> {
    const row = await this.progress.reward(runId, accountId);
    if (row === null || (row.skipped === null && row.coinsCredited === null)) return { status: "pending" };
    if (row.skipped !== null) return { status: "none", reason: row.skipped };
    return {
      status: "granted",
      coins: row.coinsCredited ?? 0,
      coinsCapped: (row.coinsCredited ?? 0) < row.coins,
      xp: row.xp,
      levelBefore: row.levelBefore,
      levelAfter: row.levelAfter,
      progress: await this.view(accountId),
    };
  }
}

export function progressView(progress: { xp: number; level: number }): ProgressView {
  const floor = xpForLevel(progress.level);
  const top = progress.level >= MAX_LEVEL;
  return {
    level: progress.level,
    xp: progress.xp,
    xpIntoLevel: progress.xp - floor,
    xpForNext: top ? null : xpForLevel(progress.level + 1) - floor,
    nextReward: top ? null : levelReward(progress.level + 1),
    upcoming: upcomingLevels(progress.level),
  };
}

function upcomingLevels(level: number): UpcomingLevel[] {
  const upcoming: UpcomingLevel[] = [];
  for (let next = level + 1; next <= Math.min(MAX_LEVEL, level + UPCOMING_LEVELS); next++) {
    upcoming.push({ level: next, ...levelReward(next), itemLevelCap: levelCap(next) });
  }
  return upcoming;
}
