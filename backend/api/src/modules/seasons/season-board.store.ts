import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { BOARD_TTL_AFTER_END_MS, type Season } from "./season-rules.js";

/**
 * Живая таблица недели — проекция забегов в Redis ZSET
 * `seasons:<ключ сезона>:<сложность>` (tasks/T-0110).
 *
 * **Источник истины — Postgres**, как у вечного рейтинга
 * (`runs/leaderboard.store.ts`): ключ можно потерять, и тогда он пересобирается
 * из базы за окно текущей недели. Закрытие сезона считает из базы, а не отсюда,
 * поэтому расхождение проекции на итоги не влияет.
 *
 * Член множества — идентификатор аккаунта, очки — лучшее время недели.
 * `ZADD GT` не опускает его ни повтором, ни худшим забегом. При равном времени
 * Redis держит порядок по идентификатору; окончательные места при ничьей
 * решает ранний забег (`seasons-close.repository.ts`), и экран этого
 * соответствия не обещает.
 *
 * Ключ живёт 21 день после конца сезона и исчезает сам.
 */

export const SEASON_BOARD_STORE = Symbol("SEASON_BOARD_STORE");

export interface SeasonBoardEntry {
  accountId: string;
  survivalSec: number;
}

export interface SeasonBoardStore {
  /** Учесть забег. `improved` — это новое лучшее время игрока недели. */
  submit(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number): Promise<{ improved: boolean }>;
  /** Место с единицы; `null` — игрока в таблице нет. */
  rank(seasonKey: string, difficulty: Difficulty, accountId: string): Promise<number | null>;
  best(seasonKey: string, difficulty: Difficulty, accountId: string): Promise<number | null>;
  /** Времена сразу нескольких игроков одним обращением; кого в таблице нет — не попадает в ответ. */
  scores(seasonKey: string, difficulty: Difficulty, accountIds: readonly string[]): Promise<Map<string, number>>;
  top(seasonKey: string, difficulty: Difficulty, limit: number): Promise<SeasonBoardEntry[]>;
  count(seasonKey: string, difficulty: Difficulty): Promise<number>;
  /** Сколько игроков с временем строго больше — место того, кого в таблице нет. */
  countAbove(seasonKey: string, difficulty: Difficulty, survivalSec: number): Promise<number>;
  /** Поставить ровно это время, даже если оно хуже; `null` — убрать игрока. */
  set(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number | null): Promise<void>;
  /** Убрать аккаунты из таблиц всех сложностей сезона — ограничение рейтинга. */
  remove(seasonKey: string, accountIds: readonly string[]): Promise<void>;
  /** Заменить таблицу сложности целиком — пересборка из базы. */
  replace(season: Season, difficulty: Difficulty, entries: readonly SeasonBoardEntry[]): Promise<void>;
}

/** Сколько членов пишется одной командой при пересборке. */
const REBUILD_BATCH = 1_000;

@Injectable()
export class RedisSeasonBoardStore implements SeasonBoardStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async submit(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number): Promise<{ improved: boolean }> {
    const target = key(season.key, difficulty);
    // Срок ставится вместе с записью: ключ не должен остаться вечным, если упадёт вторая команда.
    const results = await this.redis.multi().zadd(target, "GT", "CH", survivalSec, accountId).pexpireat(target, expiresAt(season)).exec();
    const changed = firstResult(results);
    return { improved: Number(changed) > 0 };
  }

  async rank(seasonKey: string, difficulty: Difficulty, accountId: string): Promise<number | null> {
    const index = await this.redis.zrevrank(key(seasonKey, difficulty), accountId);
    return index === null ? null : index + 1;
  }

  async best(seasonKey: string, difficulty: Difficulty, accountId: string): Promise<number | null> {
    const score = await this.redis.zscore(key(seasonKey, difficulty), accountId);
    return score === null ? null : Number(score);
  }

  async scores(seasonKey: string, difficulty: Difficulty, accountIds: readonly string[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    if (accountIds.length === 0) return found;
    const pipeline = this.redis.pipeline();
    for (const accountId of accountIds) pipeline.zscore(key(seasonKey, difficulty), accountId);
    const results = (await pipeline.exec()) ?? [];
    results.forEach(([error, score], index) => {
      if (error !== null) throw error;
      const accountId = accountIds[index];
      if (accountId !== undefined && score !== null) found.set(accountId, Number(score));
    });
    return found;
  }

  async top(seasonKey: string, difficulty: Difficulty, limit: number): Promise<SeasonBoardEntry[]> {
    const flat = await this.redis.zrevrange(key(seasonKey, difficulty), 0, limit - 1, "WITHSCORES");
    const entries: SeasonBoardEntry[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) entries.push({ accountId: flat[index] ?? "", survivalSec: Number(flat[index + 1]) });
    return entries;
  }

  async count(seasonKey: string, difficulty: Difficulty): Promise<number> {
    return await this.redis.zcard(key(seasonKey, difficulty));
  }

  async countAbove(seasonKey: string, difficulty: Difficulty, survivalSec: number): Promise<number> {
    return await this.redis.zcount(key(seasonKey, difficulty), `(${String(survivalSec)}`, "+inf");
  }

  async set(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number | null): Promise<void> {
    const target = key(season.key, difficulty);
    if (survivalSec === null) {
      await this.redis.zrem(target, accountId);
      return;
    }
    await this.redis.multi().zadd(target, survivalSec, accountId).pexpireat(target, expiresAt(season)).exec();
  }

  async remove(seasonKey: string, accountIds: readonly string[]): Promise<void> {
    if (accountIds.length === 0) return;
    for (const difficulty of DIFFICULTIES) await this.redis.zrem(key(seasonKey, difficulty), ...accountIds);
  }

  async replace(season: Season, difficulty: Difficulty, entries: readonly SeasonBoardEntry[]): Promise<void> {
    const target = key(season.key, difficulty);
    // Пересборка идёт во временный ключ и подменяет рабочий одной командой:
    // пока она идёт, игроки видят прежнюю таблицу, а не пустую.
    const temporary = `${target}:rebuild`;
    await this.redis.del(temporary);
    if (entries.length === 0) {
      await this.redis.del(target);
      return;
    }
    for (let start = 0; start < entries.length; start += REBUILD_BATCH) {
      const batch = entries.slice(start, start + REBUILD_BATCH).flatMap((entry) => [entry.survivalSec, entry.accountId]);
      await this.redis.zadd(temporary, ...batch);
    }
    await this.redis.pexpireat(temporary, expiresAt(season));
    await this.redis.rename(temporary, target);
  }
}

function key(seasonKey: string, difficulty: Difficulty): string {
  return `seasons:${seasonKey}:${difficulty}`;
}

function expiresAt(season: Season): number {
  return season.endsAt.getTime() + BOARD_TTL_AFTER_END_MS;
}

/** Результат первой команды транзакции; ошибка команды — ошибка вызова. */
function firstResult(results: [Error | null, unknown][] | null): unknown {
  const first = results?.[0];
  if (first === undefined) throw new Error("seasons: Redis не вернул результат транзакции");
  if (first[0] !== null) throw first[0];
  return first[1];
}
