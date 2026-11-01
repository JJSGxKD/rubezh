import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import { ALL_BOARDS, type Board } from "../runs/leaderboard.store.js";
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
 *
 * **Две проекции** (Р104, T-0114), как у вечного рейтинга: общая — под прежним
 * ключом, без аккаунтов со скрытым ограничением «Отдельная доска»; полная — под
 * `seasons:<ключ>:full:<сложность>`, со всеми рейтинговыми. Лучшее время игрока
 * на обеих одно, поэтому запись идёт по списку досок (по умолчанию — обе), а
 * чтение называет доску (по умолчанию — общая).
 */

export const SEASON_BOARD_STORE = Symbol("SEASON_BOARD_STORE");

export interface SeasonBoardEntry {
  accountId: string;
  survivalSec: number;
}

export interface SeasonBoardStore {
  /** Учесть забег. `improved` — это новое лучшее время игрока недели. */
  submit(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number, boards?: readonly Board[]): Promise<{ improved: boolean }>;
  /** Место с единицы; `null` — игрока в таблице нет. */
  rank(seasonKey: string, difficulty: Difficulty, accountId: string, board?: Board): Promise<number | null>;
  best(seasonKey: string, difficulty: Difficulty, accountId: string, board?: Board): Promise<number | null>;
  /** Времена сразу нескольких игроков одним обращением; кого в таблице нет — не попадает в ответ. */
  scores(seasonKey: string, difficulty: Difficulty, accountIds: readonly string[], board?: Board): Promise<Map<string, number>>;
  top(seasonKey: string, difficulty: Difficulty, limit: number, board?: Board): Promise<SeasonBoardEntry[]>;
  count(seasonKey: string, difficulty: Difficulty, board?: Board): Promise<number>;
  /** Сколько игроков с временем строго больше — место того, кого в таблице нет. */
  countAbove(seasonKey: string, difficulty: Difficulty, survivalSec: number, board?: Board): Promise<number>;
  /** Поставить ровно это время на этих досках, даже если оно хуже; `null` — убрать игрока с них. */
  set(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number | null, boards?: readonly Board[]): Promise<void>;
  /** Убрать аккаунты из таблиц всех сложностей сезона на этих досках — ограничение рейтинга (обе) или отдельная доска (общая). */
  remove(seasonKey: string, accountIds: readonly string[], boards?: readonly Board[]): Promise<void>;
  /** Заменить таблицу сложности одной доски целиком — пересборка из базы. */
  replace(season: Season, difficulty: Difficulty, entries: readonly SeasonBoardEntry[], board?: Board): Promise<void>;
}

/** Сколько членов пишется одной командой при пересборке. */
const REBUILD_BATCH = 1_000;

@Injectable()
export class RedisSeasonBoardStore implements SeasonBoardStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async submit(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number, boards: readonly Board[] = ALL_BOARDS): Promise<{ improved: boolean }> {
    let improved = false;
    for (const board of boards) {
      const target = key(season.key, difficulty, board);
      // Срок ставится вместе с записью: ключ не должен остаться вечным, если упадёт вторая команда.
      const results = await this.redis.multi().zadd(target, "GT", "CH", survivalSec, accountId).pexpireat(target, expiresAt(season)).exec();
      if (Number(firstResult(results)) > 0) improved = true;
    }
    return { improved };
  }

  async rank(seasonKey: string, difficulty: Difficulty, accountId: string, board: Board = "common"): Promise<number | null> {
    const index = await this.redis.zrevrank(key(seasonKey, difficulty, board), accountId);
    return index === null ? null : index + 1;
  }

  async best(seasonKey: string, difficulty: Difficulty, accountId: string, board: Board = "common"): Promise<number | null> {
    const score = await this.redis.zscore(key(seasonKey, difficulty, board), accountId);
    return score === null ? null : Number(score);
  }

  async scores(seasonKey: string, difficulty: Difficulty, accountIds: readonly string[], board: Board = "common"): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    if (accountIds.length === 0) return found;
    const pipeline = this.redis.pipeline();
    for (const accountId of accountIds) pipeline.zscore(key(seasonKey, difficulty, board), accountId);
    const results = (await pipeline.exec()) ?? [];
    results.forEach(([error, score], index) => {
      if (error !== null) throw error;
      const accountId = accountIds[index];
      if (accountId !== undefined && score !== null) found.set(accountId, Number(score));
    });
    return found;
  }

  async top(seasonKey: string, difficulty: Difficulty, limit: number, board: Board = "common"): Promise<SeasonBoardEntry[]> {
    const flat = await this.redis.zrevrange(key(seasonKey, difficulty, board), 0, limit - 1, "WITHSCORES");
    const entries: SeasonBoardEntry[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) entries.push({ accountId: flat[index] ?? "", survivalSec: Number(flat[index + 1]) });
    return entries;
  }

  async count(seasonKey: string, difficulty: Difficulty, board: Board = "common"): Promise<number> {
    return await this.redis.zcard(key(seasonKey, difficulty, board));
  }

  async countAbove(seasonKey: string, difficulty: Difficulty, survivalSec: number, board: Board = "common"): Promise<number> {
    return await this.redis.zcount(key(seasonKey, difficulty, board), `(${String(survivalSec)}`, "+inf");
  }

  async set(season: Season, difficulty: Difficulty, accountId: string, survivalSec: number | null, boards: readonly Board[] = ALL_BOARDS): Promise<void> {
    for (const board of boards) {
      const target = key(season.key, difficulty, board);
      if (survivalSec === null) {
        await this.redis.zrem(target, accountId);
        continue;
      }
      await this.redis.multi().zadd(target, survivalSec, accountId).pexpireat(target, expiresAt(season)).exec();
    }
  }

  async remove(seasonKey: string, accountIds: readonly string[], boards: readonly Board[] = ALL_BOARDS): Promise<void> {
    if (accountIds.length === 0) return;
    for (const board of boards) {
      for (const difficulty of DIFFICULTIES) await this.redis.zrem(key(seasonKey, difficulty, board), ...accountIds);
    }
  }

  async replace(season: Season, difficulty: Difficulty, entries: readonly SeasonBoardEntry[], board: Board = "common"): Promise<void> {
    const target = key(season.key, difficulty, board);
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

function key(seasonKey: string, difficulty: Difficulty, board: Board): string {
  return board === "full" ? `seasons:${seasonKey}:full:${difficulty}` : `seasons:${seasonKey}:${difficulty}`;
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
