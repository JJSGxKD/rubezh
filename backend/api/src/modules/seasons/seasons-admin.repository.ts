import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { DIVISIONS, type Division } from "../rating/division-rules.js";
import type { Board } from "../runs/leaderboard.store.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";

/**
 * Архив сезонов для панели (tasks/T-0380, Р189): закрытые недели, итоги по
 * сложностям с наградами и места одного игрока. Только чтение накопленных
 * итогов — `season`, `season_result`, `season_reward`; новых таблиц и индексов
 * нет. Запросы идут по индексам `(season_key, difficulty, place)` и
 * `(account_id, season_key)`.
 *
 * Сырой SQL с разбором Zod: строки из базы — граница системы, незнакомое
 * значение не должно молча стать числом в отчёте.
 *
 * **Доска строки.** `season_result.board` — доска аккаунта на закрытии:
 * `common` — общая, `full` — аккаунт с отдельной доской (Р104). Места и размер
 * в строке — своей доски, поэтому «итоги отдельной доски» — это строки
 * `board = 'full'`, а не вторая раскладка тех же аккаунтов. Решает ли читатель
 * видеть такие строки, знает сервис; репозиторий отдаёт то, что просили.
 */

export interface ArchiveSeason {
  key: string;
  startsAt: Date;
  endsAt: Date;
  closedAt: Date;
  players: number;
  rewarded: number;
}

/** Награда аккаунта за сезон; сложность и место есть только у награды за место. */
export interface ArchiveReward {
  kind: "place" | "threshold";
  coins: number;
  prestige: number;
  status: "pending" | "claimed";
  claimedAt: Date | null;
  difficulty: Difficulty | null;
  place: number | null;
}

export interface ArchiveResultRow {
  place: number;
  accountId: string;
  name: string;
  /** секунды в сезоне по времени, очки в сезоне по очкам — смотря как ранжирован сезон */
  best: number;
  boardSize: number;
  division: Division | null;
  reward: ArchiveReward | null;
}

export interface ArchivePlayerResult {
  difficulty: Difficulty;
  best: number;
  place: number;
  boardSize: number;
  division: Division | null;
  board: Board;
}

export interface ArchivePlayerSeason {
  key: string;
  startsAt: Date;
  results: ArchivePlayerResult[];
  reward: ArchiveReward | null;
}

export const SEASONS_ADMIN_REPOSITORY = Symbol("SEASONS_ADMIN_REPOSITORY");

export interface SeasonsAdminRepository {
  /** Закрытые сезоны старше `before`, новые первыми; `more` — за страницей есть ещё. */
  seasons(before: string | null, limit: number): Promise<{ seasons: ArchiveSeason[]; more: boolean }>;
  season(key: string): Promise<ArchiveSeason | null>;
  /** Итоги сезона по сложности и доске, по местам; `total` — все строки, не только страница. */
  results(key: string, difficulty: Difficulty, board: Board, offset: number, limit: number): Promise<{ rows: ArchiveResultRow[]; total: number }>;
  /** Сезоны аккаунта с итогами и наградой, новые первыми; `includeFull` — вместе со строками отдельной доски. */
  playerSeasons(accountId: string, includeFull: boolean, limit: number): Promise<ArchivePlayerSeason[]>;
}

/** Колонка — строка без проверки в базе: незнакомое значение читается как «дивизиона нет», а не роняет страницу. */
const division = z.enum(DIVISIONS).nullable().catch(null);
const difficulty = z.enum(DIFFICULTIES);
const count = z.number().int().nonnegative();

const seasonRow = z.object({ season_key: z.string(), starts_at: z.date(), ends_at: z.date(), closed_at: z.date(), players: count, rewarded: count });

/** Поля награды в соединённых запросах; без награды все пусты. */
const rewardColumns = {
  reward_kind: z.string().nullable(),
  reward_coins: count.nullable(),
  reward_prestige: count.nullable(),
  reward_status: z.string().nullable(),
  reward_claimed_at: z.date().nullable(),
  reward_difficulty: difficulty.nullable(),
  reward_place: count.nullable(),
};

const resultRow = z.object({
  place: count,
  account_id: z.string(),
  display_name: z.string(),
  best_sec: z.number(),
  board_size: count,
  division,
  ...rewardColumns,
});

const playerRow = z.object({
  season_key: z.string(),
  starts_at: z.date(),
  difficulty,
  best_sec: z.number(),
  place: count,
  board_size: count,
  division,
  board: z.enum(["common", "full"]),
  ...rewardColumns,
});

type RewardColumns = { [K in keyof typeof rewardColumns]: z.infer<(typeof rewardColumns)[K]> };

function rewardOf(row: RewardColumns): ArchiveReward | null {
  if (row.reward_kind === null || row.reward_coins === null || row.reward_prestige === null) return null;
  return {
    // Колонки — строки с проверкой в базе; незнакомое значение читается безопасно, а не роняет чтение.
    kind: row.reward_kind === "place" ? "place" : "threshold",
    coins: row.reward_coins,
    prestige: row.reward_prestige,
    status: row.reward_status === "claimed" ? "claimed" : "pending",
    claimedAt: row.reward_claimed_at,
    difficulty: row.reward_difficulty,
    place: row.reward_place,
  };
}

function seasonOf(row: z.infer<typeof seasonRow>): ArchiveSeason {
  return { key: row.season_key, startsAt: row.starts_at, endsAt: row.ends_at, closedAt: row.closed_at, players: row.players, rewarded: row.rewarded };
}

@Injectable()
export class PrismaSeasonsAdminRepository implements SeasonsAdminRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async seasons(before: string | null, limit: number): Promise<{ seasons: ArchiveSeason[]; more: boolean }> {
    // Лишняя строка не отдаётся, а только говорит, что страница не последняя.
    const rows = z.array(seasonRow).parse(
      await this.prisma.$queryRaw`
        SELECT season_key, starts_at, ends_at, closed_at, players, rewarded
        FROM season
        WHERE ${before}::text IS NULL OR season_key < ${before}::text
        ORDER BY season_key DESC
        LIMIT ${limit + 1}`,
    );
    return { seasons: rows.slice(0, limit).map(seasonOf), more: rows.length > limit };
  }

  async season(key: string): Promise<ArchiveSeason | null> {
    const rows = z.array(seasonRow).parse(await this.prisma.$queryRaw`SELECT season_key, starts_at, ends_at, closed_at, players, rewarded FROM season WHERE season_key = ${key}`);
    const row = rows[0];
    return row === undefined ? null : seasonOf(row);
  }

  async results(key: string, difficultyOf: Difficulty, board: Board, offset: number, limit: number): Promise<{ rows: ArchiveResultRow[]; total: number }> {
    const [rows, totals] = await Promise.all([
      // Награда за место стоит в строке своей сложности, награда за порог — в каждой строке аккаунта.
      this.prisma.$queryRaw`
        SELECT sr.place, sr.account_id::text AS account_id, a.display_name, sr.best_sec, sr.board_size, sr.division,
               r.kind AS reward_kind, r.coins AS reward_coins, r.prestige AS reward_prestige, r.status AS reward_status,
               r.claimed_at AS reward_claimed_at, r.difficulty AS reward_difficulty, r.place AS reward_place
        FROM season_result sr
        JOIN account a ON a.account_id = sr.account_id
        LEFT JOIN season_reward r
          ON r.season_key = sr.season_key AND r.account_id = sr.account_id AND (r.kind = 'threshold' OR r.difficulty = sr.difficulty)
        WHERE sr.season_key = ${key} AND sr.difficulty = ${difficultyOf}::"Difficulty" AND sr.board = ${board}
        ORDER BY sr.place, sr.account_id
        OFFSET ${offset} LIMIT ${limit}`,
      this.prisma.$queryRaw`
        SELECT count(*)::int AS total FROM season_result
        WHERE season_key = ${key} AND difficulty = ${difficultyOf}::"Difficulty" AND board = ${board}`,
    ]);
    return {
      rows: z.array(resultRow).parse(rows).map((row) => ({
        place: row.place,
        accountId: row.account_id,
        name: row.display_name,
        best: row.best_sec,
        boardSize: row.board_size,
        division: row.division,
        reward: rewardOf(row),
      })),
      total: z.array(z.object({ total: count })).parse(totals)[0]?.total ?? 0,
    };
  }

  async playerSeasons(accountId: string, includeFull: boolean, limit: number): Promise<ArchivePlayerSeason[]> {
    // Сезоны отбираются по тем же строкам, что и показываются: без права на отдельную доску сезон из одних её строк не появляется пустым.
    const rows = z.array(playerRow).parse(
      await this.prisma.$queryRaw`
        SELECT sr.season_key, s.starts_at, sr.difficulty, sr.best_sec, sr.place, sr.board_size, sr.division, sr.board,
               r.kind AS reward_kind, r.coins AS reward_coins, r.prestige AS reward_prestige, r.status AS reward_status,
               r.claimed_at AS reward_claimed_at, r.difficulty AS reward_difficulty, r.place AS reward_place
        FROM season_result sr
        JOIN season s ON s.season_key = sr.season_key
        LEFT JOIN season_reward r ON r.season_key = sr.season_key AND r.account_id = sr.account_id
        WHERE sr.account_id = ${accountId}::uuid AND (${includeFull}::boolean OR sr.board = 'common')
          AND sr.season_key IN (
            SELECT DISTINCT season_key FROM season_result
            WHERE account_id = ${accountId}::uuid AND (${includeFull}::boolean OR board = 'common')
            ORDER BY season_key DESC
            LIMIT ${limit})
        ORDER BY sr.season_key DESC`,
    );
    const seasons = new Map<string, ArchivePlayerSeason>();
    for (const row of rows) {
      let season = seasons.get(row.season_key);
      if (season === undefined) {
        season = { key: row.season_key, startsAt: row.starts_at, results: [], reward: rewardOf(row) };
        seasons.set(row.season_key, season);
      }
      season.results.push({ difficulty: row.difficulty, best: row.best_sec, place: row.place, boardSize: row.board_size, division: row.division, board: row.board });
    }
    for (const season of seasons.values()) season.results.sort((left, right) => DIFFICULTIES.indexOf(left.difficulty) - DIFFICULTIES.indexOf(right.difficulty));
    return [...seasons.values()];
  }
}
