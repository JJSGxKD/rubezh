import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import type { Difficulty } from "./run-rules.js";

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
 */

export const LEADERBOARD_STORE = Symbol("LEADERBOARD_STORE");

export interface LeaderboardEntry {
  accountId: string;
  survivalSec: number;
}

export interface LeaderboardStore {
  /** Учесть забег. `improved` — это новое лучшее время игрока. */
  submit(difficulty: Difficulty, accountId: string, survivalSec: number): Promise<{ improved: boolean }>;
  /** Место с единицы; `null` — рейтинговых забегов нет. */
  rank(difficulty: Difficulty, accountId: string): Promise<number | null>;
  best(difficulty: Difficulty, accountId: string): Promise<number | null>;
  top(difficulty: Difficulty, limit: number): Promise<LeaderboardEntry[]>;
  count(difficulty: Difficulty): Promise<number>;
  /** Заменить проекцию целиком — пересборка из базы. */
  replace(difficulty: Difficulty, entries: readonly LeaderboardEntry[]): Promise<void>;
}

/** Сколько членов пишется одной командой при пересборке. */
const REBUILD_BATCH = 1_000;

@Injectable()
export class RedisLeaderboardStore implements LeaderboardStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async submit(difficulty: Difficulty, accountId: string, survivalSec: number): Promise<{ improved: boolean }> {
    // CH — число изменённых членов: 1, если игрок новый или время выросло.
    const changed = await this.redis.zadd(key(difficulty), "GT", "CH", survivalSec, accountId);
    return { improved: Number(changed) > 0 };
  }

  async rank(difficulty: Difficulty, accountId: string): Promise<number | null> {
    const index = await this.redis.zrevrank(key(difficulty), accountId);
    return index === null ? null : index + 1;
  }

  async best(difficulty: Difficulty, accountId: string): Promise<number | null> {
    const score = await this.redis.zscore(key(difficulty), accountId);
    return score === null ? null : Number(score);
  }

  async top(difficulty: Difficulty, limit: number): Promise<LeaderboardEntry[]> {
    const flat = await this.redis.zrevrange(key(difficulty), 0, limit - 1, "WITHSCORES");
    const entries: LeaderboardEntry[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      entries.push({ accountId: flat[index] ?? "", survivalSec: Number(flat[index + 1]) });
    }
    return entries;
  }

  async count(difficulty: Difficulty): Promise<number> {
    return await this.redis.zcard(key(difficulty));
  }

  async replace(difficulty: Difficulty, entries: readonly LeaderboardEntry[]): Promise<void> {
    // Пересборка идёт во временный ключ и подменяет рабочий одной командой:
    // пока она идёт, игроки видят старый рейтинг, а не пустой.
    const temporary = `${key(difficulty)}:rebuild`;
    await this.redis.del(temporary);
    for (let start = 0; start < entries.length; start += REBUILD_BATCH) {
      const batch = entries.slice(start, start + REBUILD_BATCH).flatMap((entry) => [entry.survivalSec, entry.accountId]);
      await this.redis.zadd(temporary, ...batch);
    }
    if (entries.length === 0) {
      await this.redis.del(key(difficulty));
      return;
    }
    await this.redis.rename(temporary, key(difficulty));
  }
}

function key(difficulty: Difficulty): string {
  return `runs:leaderboard:${difficulty}`;
}
