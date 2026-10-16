import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { rewardFor, type Season } from "./season-rules.js";

/**
 * Закрытие недельного сезона в Postgres (tasks/T-0110): итоги, места и
 * награды за неделю — одной транзакцией.
 *
 * **Идемпотентность держит база.** Первой в транзакции вставляется строка
 * `season`; её первичный ключ — это замок. Вторая реплика, закрывающая тот же
 * сезон, ждёт на этой вставке, а после коммита первой получает ноль вставленных
 * строк и уходит ни с чем: итоги не задваиваются и без лока Redis.
 * Остальные вставки — `ON CONFLICT DO NOTHING`: упавшая и повторённая
 * транзакция ничего не ломает.
 *
 * Места считает одна оконная функция: время по убыванию, при равенстве выше
 * тот, кто показал его раньше. Источник — таблица `run`, а не Redis, поэтому
 * снятие забега модератором до закрытия учтено само.
 */

/** Аккаунтов в одной пачке наград: память держит пачку, а не весь сезон. */
const REWARD_BATCH = 2_000;
/** Закрытие большого сезона — долгая транзакция, а не обычный запрос игрока. */
const TRANSACTION_TIMEOUT_MS = 120_000;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const FIRST_ACCOUNT = "00000000-0000-0000-0000-000000000000";

/** Итог закрытия — то, что идёт в событие `season_closed`. */
export interface SeasonClosed {
  seasonKey: string;
  players: number;
  rewarded: number;
  coinsTotal: number;
  prestigeTotal: number;
  /** сколько игроков было в таблице каждой сложности */
  boardSize: Record<Difficulty, number>;
}

export const SEASON_CLOSE_REPOSITORY = Symbol("SEASON_CLOSE_REPOSITORY");

export interface SeasonCloseRepository {
  /** Какие из ключей уже закрыты. */
  closedKeys(seasonKeys: readonly string[]): Promise<Set<string>>;
  /**
   * Закрыть сезон. `excluded` — аккаунты с закрытым рейтингом: в итогах их
   * нет, места считаются без них. `null` — сезон уже закрыт, не нами.
   */
  close(season: Season, excluded: readonly string[], now: Date): Promise<SeasonClosed | null>;
}

@Injectable()
export class PrismaSeasonCloseRepository implements SeasonCloseRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async closedKeys(seasonKeys: readonly string[]): Promise<Set<string>> {
    if (seasonKeys.length === 0) return new Set();
    const rows = await this.prisma.season.findMany({ where: { seasonKey: { in: [...seasonKeys] } }, select: { seasonKey: true } });
    return new Set(rows.map((row) => row.seasonKey));
  }

  async close(season: Season, excluded: readonly string[], now: Date): Promise<SeasonClosed | null> {
    return await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.$executeRaw`
          INSERT INTO season (season_key, starts_at, ends_at, closed_at, players, rewarded)
          VALUES (${season.key}, ${season.startsAt}, ${season.endsAt}, ${now}, 0, 0)
          ON CONFLICT (season_key) DO NOTHING`;
        if (created === 0) return null;

        await tx.$executeRaw`
          INSERT INTO season_result (season_key, account_id, difficulty, best_sec, place, board_size)
          SELECT ${season.key}, ranked.account_id, ranked.difficulty, ranked.best_sec, ranked.place, ranked.board_size
          FROM (
            SELECT best.account_id, best.difficulty, best.best_sec,
                   rank() OVER (PARTITION BY best.difficulty ORDER BY best.best_sec DESC, best.first_at ASC) AS place,
                   count(*) OVER (PARTITION BY best.difficulty) AS board_size
            FROM (
              SELECT DISTINCT ON (r.account_id, r.difficulty) r.account_id, r.difficulty, r.survival_sec AS best_sec, r.finished_at AS first_at
              FROM run r
              WHERE r.status = 'finished' AND r.ranked AND r.survival_sec IS NOT NULL
                AND r.finished_at >= ${season.startsAt} AND r.finished_at < ${season.endsAt}
                AND NOT (r.account_id = ANY(${[...excluded]}::uuid[]))
              ORDER BY r.account_id, r.difficulty, r.survival_sec DESC, r.finished_at ASC
            ) best
          ) ranked
          ON CONFLICT DO NOTHING`;

        await this.assignRewards(tx, season.key);

        await tx.$executeRaw`
          UPDATE season
          SET players = (SELECT count(DISTINCT account_id) FROM season_result WHERE season_key = ${season.key}),
              rewarded = (SELECT count(*) FROM season_reward WHERE season_key = ${season.key})
          WHERE season_key = ${season.key}`;
        return await this.summary(tx, season.key);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  /**
   * Награды считает код (`rewardFor`), а не SQL: числа живут в одном месте.
   * Аккаунты идут пачками по ключу, чтобы сезон на миллион игроков не лёг в память.
   */
  private async assignRewards(tx: Transaction, seasonKey: string): Promise<void> {
    let after = FIRST_ACCOUNT;
    for (;;) {
      const accounts = await tx.$queryRaw<{ account_id: string }[]>`
        SELECT DISTINCT account_id FROM season_result
        WHERE season_key = ${seasonKey} AND account_id > ${after}::uuid
        ORDER BY account_id LIMIT ${REWARD_BATCH}`;
      if (accounts.length === 0) return;
      const ids = accounts.map((row) => row.account_id);
      after = ids[ids.length - 1] ?? after;

      const rows = await tx.seasonResult.findMany({ where: { seasonKey, accountId: { in: ids } } });
      const byAccount = new Map<string, typeof rows>();
      for (const row of rows) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);

      const prizes = ids.flatMap((accountId) => {
        const prize = rewardFor((byAccount.get(accountId) ?? []).map((row) => ({ difficulty: row.difficulty, bestSec: row.bestSec, place: row.place, boardSize: row.boardSize })));
        return prize === null ? [] : [{ account_id: accountId, coins: prize.coins, prestige: prize.prestige, difficulty: prize.difficulty, place: prize.place, kind: prize.kind }];
      });
      if (prizes.length > 0) {
        // JSON, а не массивы по колонкам: у награды за порог сложность и место пусты.
        await tx.$executeRaw`
          INSERT INTO season_reward (season_key, account_id, coins, prestige, difficulty, place, kind, status)
          SELECT ${seasonKey}, t.account_id, t.coins, t.prestige, t.difficulty::"Difficulty", t.place, t.kind, 'pending'
          FROM jsonb_to_recordset(${JSON.stringify(prizes)}::jsonb) AS t(account_id uuid, coins int, prestige int, difficulty text, place int, kind text)
          ON CONFLICT DO NOTHING`;
      }
      if (accounts.length < REWARD_BATCH) return;
    }
  }

  private async summary(tx: Transaction, seasonKey: string): Promise<SeasonClosed> {
    const [season, totals, boards] = await Promise.all([
      tx.season.findUniqueOrThrow({ where: { seasonKey }, select: { players: true, rewarded: true } }),
      tx.seasonReward.aggregate({ where: { seasonKey }, _sum: { coins: true, prestige: true } }),
      tx.seasonResult.groupBy({ by: ["difficulty"], where: { seasonKey }, _max: { boardSize: true } }),
    ]);
    const boardSize = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, boards.find((row) => row.difficulty === difficulty)?._max.boardSize ?? 0])) as Record<Difficulty, number>;
    return { seasonKey, players: season.players, rewarded: season.rewarded, coinsTotal: totals._sum.coins ?? 0, prestigeTotal: totals._sum.prestige ?? 0, boardSize };
  }
}

type Transaction = Prisma.TransactionClient;
