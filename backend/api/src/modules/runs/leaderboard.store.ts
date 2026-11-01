import { Inject, Injectable } from "@nestjs/common";
import type { ChainableCommander, Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import { DIFFICULTIES, type Difficulty } from "./run-rules.js";

/**
 * Лидерборд — проекция забегов в Redis ZSET (docs/34-stage3-plan.md, Р4).
 *
 * **Источник истины — Postgres, а не этот ключ.** Redis — кеш, его можно
 * потерять, и тогда рейтинг пересобирается из базы одной командой
 * (`pnpm --filter backend-api runs:rebuild-leaderboard`). Поэтому сюда
 * пишется только то, что уже лежит в таблице `run` с `ranked = true`.
 *
 * Член множества — идентификатор аккаунта, очки — лучшее время. Лучшее
 * только растёт: `ZADD GT` не опустит его ни повтором, ни худшим забегом, и
 * делает это атомарно — без чтения и записи из кода.
 *
 * **Две проекции одного источника** (docs/35-stage4-plan.md, Р104, T-0113).
 * Общая доска лежит под прежним ключом `runs:leaderboard:<сложность>` — её
 * читают все; полная — под `runs:leaderboard:full:<сложность>`, в ней ещё и
 * аккаунты со скрытым ограничением «Отдельная доска», и читают её только они.
 * Лучшее время игрока на обеих досках одно, поэтому запись идёт по списку
 * досок, а каждое чтение называет доску — прямого чтения без доски нет.
 */

export const LEADERBOARD_STORE = Symbol("LEADERBOARD_STORE");

/** Доска: общая — без аккаунтов с отдельной доской, полная — со всеми рейтинговыми. */
export type Board = "common" | "full";

/** Обычному игроку положены обе доски, аккаунту с отдельной доской — только полная. */
export const ALL_BOARDS: readonly Board[] = ["full", "common"];
export const COMMON_ONLY: readonly Board[] = ["common"];
export const FULL_ONLY: readonly Board[] = ["full"];

export interface LeaderboardEntry {
  accountId: string;
  survivalSec: number;
}

export interface LeaderboardStore {
  /** Учесть забег на этих досках. `improved` — новое лучшее время игрока хотя бы на одной. */
  submit(difficulty: Difficulty, accountId: string, survivalSec: number, boards: readonly Board[]): Promise<{ improved: boolean }>;
  /** Место с единицы; `null` — игрока в этой доске нет. */
  rank(difficulty: Difficulty, accountId: string, board: Board): Promise<number | null>;
  best(difficulty: Difficulty, accountId: string, board: Board): Promise<number | null>;
  top(difficulty: Difficulty, limit: number, board: Board): Promise<LeaderboardEntry[]>;
  count(difficulty: Difficulty, board: Board): Promise<number>;
  /** Сколько игроков в доске с временем строго больше — место того, кого в доске нет. */
  countAbove(difficulty: Difficulty, survivalSec: number, board: Board): Promise<number>;
  /**
   * Поставить ровно это время, даже если оно хуже, — после того как
   * модератор снял забег с рейтинга; `null` — убрать из доски сложности.
   */
  set(difficulty: Difficulty, accountId: string, survivalSec: number | null, boards: readonly Board[]): Promise<void>;
  /** Убрать аккаунты из этих досок всех сложностей — ограничения рейтинга; возвращает, сколько мест снято. */
  remove(accountIds: readonly string[], boards: readonly Board[]): Promise<number>;
  /** Заменить проекцию одной доски целиком — пересборка из базы. */
  replace(difficulty: Difficulty, board: Board, entries: readonly LeaderboardEntry[]): Promise<void>;
}

/** Сколько членов пишется одной командой при пересборке. */
const REBUILD_BATCH = 1_000;

@Injectable()
export class RedisLeaderboardStore implements LeaderboardStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async submit(difficulty: Difficulty, accountId: string, survivalSec: number, boards: readonly Board[]): Promise<{ improved: boolean }> {
    // CH — число изменённых членов: 1, если игрок новый на доске или время выросло.
    // Все доски — одной транзакцией MULTI: запись не остаётся наполовину.
    const changed = await this.write(boards, (pipeline, board) => pipeline.zadd(key(difficulty, board), "GT", "CH", survivalSec, accountId));
    return { improved: changed.some((count) => count > 0) };
  }

  async rank(difficulty: Difficulty, accountId: string, board: Board): Promise<number | null> {
    const index = await this.redis.zrevrank(key(difficulty, board), accountId);
    return index === null ? null : index + 1;
  }

  async best(difficulty: Difficulty, accountId: string, board: Board): Promise<number | null> {
    const score = await this.redis.zscore(key(difficulty, board), accountId);
    return score === null ? null : Number(score);
  }

  async top(difficulty: Difficulty, limit: number, board: Board): Promise<LeaderboardEntry[]> {
    const flat = await this.redis.zrevrange(key(difficulty, board), 0, limit - 1, "WITHSCORES");
    const entries: LeaderboardEntry[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      entries.push({ accountId: flat[index] ?? "", survivalSec: Number(flat[index + 1]) });
    }
    return entries;
  }

  async count(difficulty: Difficulty, board: Board): Promise<number> {
    return await this.redis.zcard(key(difficulty, board));
  }

  async countAbove(difficulty: Difficulty, survivalSec: number, board: Board): Promise<number> {
    return await this.redis.zcount(key(difficulty, board), `(${String(survivalSec)}`, "+inf");
  }

  async set(difficulty: Difficulty, accountId: string, survivalSec: number | null, boards: readonly Board[]): Promise<void> {
    await this.write(boards, (pipeline, board) => (survivalSec === null ? pipeline.zrem(key(difficulty, board), accountId) : pipeline.zadd(key(difficulty, board), survivalSec, accountId)));
  }

  async remove(accountIds: readonly string[], boards: readonly Board[]): Promise<number> {
    if (accountIds.length === 0 || boards.length === 0) return 0;
    const places = boards.flatMap((board) => DIFFICULTIES.map((difficulty) => ({ board, difficulty })));
    const removed = await this.write(places, (pipeline, place) => pipeline.zrem(key(place.difficulty, place.board), ...accountIds));
    return removed.reduce((sum, count) => sum + count, 0);
  }

  async replace(difficulty: Difficulty, board: Board, entries: readonly LeaderboardEntry[]): Promise<void> {
    // Пересборка идёт во временный ключ своей доски и подменяет рабочий одной
    // командой: пока она идёт, игроки видят старый рейтинг, а не пустой.
    const target = key(difficulty, board);
    const temporary = `${target}:rebuild`;
    await this.redis.del(temporary);
    for (let start = 0; start < entries.length; start += REBUILD_BATCH) {
      const batch = entries.slice(start, start + REBUILD_BATCH).flatMap((entry) => [entry.survivalSec, entry.accountId]);
      await this.redis.zadd(temporary, ...batch);
    }
    if (entries.length === 0) {
      await this.redis.del(target);
      return;
    }
    await this.redis.rename(temporary, target);
  }

  /** Команда на каждый элемент списка одной транзакцией MULTI; числа ответов — в порядке списка. */
  private async write<T>(items: readonly T[], command: (pipeline: ChainableCommander, item: T) => ChainableCommander): Promise<number[]> {
    const pipeline = this.redis.multi();
    for (const item of items) command(pipeline, item);
    const replies = (await pipeline.exec()) ?? [];
    return replies.map(([error, reply]) => {
      if (error !== null) throw error;
      return Number(reply);
    });
  }
}

/** Общая доска — прежний ключ: все остальные игроки читают её без перехода. */
function key(difficulty: Difficulty, board: Board): string {
  return board === "full" ? `runs:leaderboard:full:${difficulty}` : `runs:leaderboard:${difficulty}`;
}
