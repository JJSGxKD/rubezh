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
 *
 * **Отметка рубежа** (T-0121, Р102): засчитанная победа над стражем лежит
 * отдельным набором `lb:rubezh:<сложность>` (accountId), общим для обеих досок:
 * победа — свойство аккаунта, а не доски. Пишется в той же транзакции, что
 * и рекорд; `top` читает флаги всей страницы одним `SMISMEMBER`. Набор — такая
 * же проекция базы, как и доски: пересборка собирает его заново.
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
  /** у аккаунта засчитана победа над стражем на этой сложности; поля нет — не засчитана */
  rubezh?: true;
}

export interface LeaderboardStore {
  /**
   * Учесть забег на этих досках. `improved` — новое лучшее время игрока хотя бы
   * на одной. `rubezh` — забег засчитан победой над стражем: аккаунт попадает в
   * набор отметки; `false` набор не трогает, отметку снимает только пересборка
   * или `setRubezh`.
   */
  submit(difficulty: Difficulty, accountId: string, survivalSec: number, boards: readonly Board[], rubezh?: boolean): Promise<{ improved: boolean }>;
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
  /** Заменить набор победителей сложности целиком — пересборка из базы. */
  replaceRubezh(difficulty: Difficulty, accountIds: readonly string[]): Promise<void>;
  /** Поставить или снять отметку одному аккаунту — после того как модератор снял забег с рейтинга. */
  setRubezh(difficulty: Difficulty, accountId: string, won: boolean): Promise<void>;
}

/** Сколько членов пишется одной командой при пересборке. */
const REBUILD_BATCH = 1_000;

@Injectable()
export class RedisLeaderboardStore implements LeaderboardStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async submit(difficulty: Difficulty, accountId: string, survivalSec: number, boards: readonly Board[], rubezh = false): Promise<{ improved: boolean }> {
    // CH — число изменённых членов: 1, если игрок новый на доске или время выросло.
    // Все доски и отметка рубежа — одной транзакцией MULTI: запись не остаётся наполовину.
    const writes: readonly (Board | "rubezh")[] = rubezh ? [...boards, "rubezh"] : boards;
    const changed = await this.write(writes, (pipeline, place) =>
      place === "rubezh" ? pipeline.sadd(rubezhKey(difficulty), accountId) : pipeline.zadd(key(difficulty, place), "GT", "CH", survivalSec, accountId),
    );
    // Отметка в `improved` не входит: «новый рекорд» — это время.
    return { improved: changed.slice(0, boards.length).some((count) => count > 0) };
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
    if (entries.length === 0) return entries;
    // Один запрос на всю страницу, а не по запросу на строку.
    const won = await this.redis.smismember(rubezhKey(difficulty), ...entries.map((entry) => entry.accountId));
    return entries.map((entry, index) => (won[index] === 1 ? { ...entry, rubezh: true as const } : entry));
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

  async replaceRubezh(difficulty: Difficulty, accountIds: readonly string[]): Promise<void> {
    // Как и доски: собираем во временный ключ и подменяем одной командой.
    const target = rubezhKey(difficulty);
    const temporary = `${target}:rebuild`;
    await this.redis.del(temporary);
    for (let start = 0; start < accountIds.length; start += REBUILD_BATCH) {
      await this.redis.sadd(temporary, ...accountIds.slice(start, start + REBUILD_BATCH));
    }
    if (accountIds.length === 0) {
      await this.redis.del(target);
      return;
    }
    await this.redis.rename(temporary, target);
  }

  async setRubezh(difficulty: Difficulty, accountId: string, won: boolean): Promise<void> {
    if (won) await this.redis.sadd(rubezhKey(difficulty), accountId);
    else await this.redis.srem(rubezhKey(difficulty), accountId);
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

/** Набор победителей над стражем: один на сложность, общий для обеих досок. */
function rubezhKey(difficulty: Difficulty): string {
  return `lb:rubezh:${difficulty}`;
}

/** Общая доска — прежний ключ: все остальные игроки читают её без перехода. */
function key(difficulty: Difficulty, board: Board): string {
  return board === "full" ? `runs:leaderboard:full:${difficulty}` : `runs:leaderboard:${difficulty}`;
}
