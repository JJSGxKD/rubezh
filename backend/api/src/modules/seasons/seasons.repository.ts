import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { DIVISIONS, type Division } from "../rating/division-rules.js";
import type { Scoring } from "../rating/rating-switch.js";
import type { BestRunRow } from "../runs/runs.repository.js";
import { DIFFICULTIES, isRatedDifficulty, type Difficulty } from "../runs/run-rules.js";
import type { Season, SeasonResultLine } from "./season-rules.js";

/**
 * Недельный сезон в Postgres, чтение и забор награды (tasks/T-0110). Запрос к
 * базе живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 * Закрытие сезона — в `seasons-close.repository.ts`: оно пишет итоги и держит
 * свой сырой SQL.
 *
 * Окно недели везде одно: `finished_at` от начала сезона включительно до его
 * конца исключительно, и только законченные рейтинговые забеги. Снятие забега
 * модератором (`ranked = false`) учитывается само: база — источник истины.
 *
 * Единая сложность (Р126, T-0191): считаются только рейтинговые сложности, а
 * нижняя граница окна — не раньше отсечки `rating.since-date`,
 * `[max(начало недели, отсечка), конец недели)`. Нерейтинговой сложности запрос
 * в базу не уходит вовсе.
 *
 * Режим сезона (tasks/T-0294) приходит параметром `scoring`: по времени лучший
 * забег — с наибольшим `survivalSec`, по очкам — с наибольшим `points`, и забег
 * без очков в выборку не входит. При равном счёте выше тот, кто закончил
 * раньше. По умолчанию — время: так считались все сезоны до перехода. Отсечку знает расписание (`SeasonSchedule.ratingSince`),
 * сюда её передают параметром.
 */

export type RewardKind = "place" | "threshold";
export type RewardStatus = "pending" | "claimed";

export interface RewardRow {
  seasonKey: string;
  kind: RewardKind;
  difficulty: Difficulty | null;
  place: number | null;
  coins: number;
  prestige: number;
  status: RewardStatus;
}

/** Строка итога в истории: с дивизионом, записанным при закрытии (T-0295); `null` — сезон закрыт до дивизионов. */
export interface HistoryResult extends SeasonResultLine {
  division: Division | null;
}

export interface HistoryRow {
  seasonKey: string;
  startsAt: Date;
  endsAt: Date;
  results: HistoryResult[];
  reward: { coins: number; prestige: number; claimed: boolean } | null;
}

/** Лучший забег недели аккаунта: счёт сезона и подписи к нему. */
export interface WeekBest {
  /** секунды в сезоне по времени, очки в сезоне по очкам */
  score: number;
  survivalSec: number;
  points: number | null;
  style: string | null;
}

export const SEASONS_REPOSITORY = Symbol("SEASONS_REPOSITORY");

export interface SeasonsRepository {
  /** Лучший рейтинговый счёт каждого аккаунта за неделю — источник пересборки живой таблицы. */
  weekBests(difficulty: Difficulty, season: Season, excluded: readonly string[], since: Date | null, scoring?: Scoring): Promise<{ accountId: string; score: number }[]>;
  /**
   * Лучший забег аккаунта за неделю. `shadow` — вместе со сданными под
   * молчаливым ограничением рейтинга: так игрок видит себя сам.
   */
  bestRun(accountId: string, difficulty: Difficulty, season: Season, shadow: boolean, since: Date | null, scoring?: Scoring): Promise<WeekBest | null>;
  /** Лучший забег недели каждого из аккаунтов — для строк таблицы, одним запросом на страницу. */
  boardRuns(accountIds: readonly string[], difficulty: Difficulty, season: Season, since: Date | null, scoring?: Scoring): Promise<BestRunRow[]>;
  rewardOf(seasonKey: string, accountId: string): Promise<RewardRow | null>;
  /** Ждущие награды аккаунта, свежие сезоны первыми. */
  pendingRewards(accountId: string): Promise<RewardRow[]>;
  /** `pending → claimed` одним условным обновлением; `false` — награду уже забрали. */
  markClaimed(seasonKey: string, accountId: string, at: Date): Promise<boolean>;
  /** Закрытые сезоны, где аккаунт что-то получил или занял место, свежие первыми. */
  history(accountId: string, limit: number): Promise<HistoryRow[]>;
}

@Injectable()
export class PrismaSeasonsRepository implements SeasonsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async weekBests(difficulty: Difficulty, season: Season, excluded: readonly string[], since: Date | null, scoring: Scoring = "time"): Promise<{ accountId: string; score: number }[]> {
    if (!isRatedDifficulty(difficulty)) return [];
    const rows = await this.prisma.run.groupBy({
      by: ["accountId"],
      where: { ...windowOf(season, since), ...scoredWhere(scoring), difficulty, ranked: true, accountId: { notIn: [...excluded] } },
      _max: { survivalSec: true, points: true },
    });
    return rows.map((row) => ({ accountId: row.accountId, score: (scoring === "points" ? row._max.points : row._max.survivalSec) ?? 0 }));
  }

  async bestRun(accountId: string, difficulty: Difficulty, season: Season, shadow: boolean, since: Date | null, scoring: Scoring = "time"): Promise<WeekBest | null> {
    if (!isRatedDifficulty(difficulty)) return null;
    const row = await this.prisma.run.findFirst({
      where: { ...windowOf(season, since), ...scoredWhere(scoring), accountId, difficulty, OR: shadow ? [{ ranked: true }, { ratingRestricted: "silent" }] : [{ ranked: true }] },
      orderBy: [scoreOrder(scoring), { finishedAt: "asc" }],
      select: { survivalSec: true, points: true, style: true },
    });
    if (row === null) return null;
    const survivalSec = row.survivalSec ?? 0;
    return { score: (scoring === "points" ? row.points : survivalSec) ?? 0, survivalSec, points: row.points, style: row.style };
  }

  async boardRuns(accountIds: readonly string[], difficulty: Difficulty, season: Season, since: Date | null, scoring: Scoring = "time"): Promise<BestRunRow[]> {
    if (accountIds.length === 0 || !isRatedDifficulty(difficulty)) return [];
    // `distinct` с сортировкой по счёту сезона берёт лучший забег недели каждого аккаунта.
    const rows = await this.prisma.run.findMany({
      where: { ...windowOf(season, since), ...scoredWhere(scoring), accountId: { in: [...accountIds] }, difficulty, ranked: true },
      orderBy: [{ accountId: "asc" }, scoreOrder(scoring), { finishedAt: "asc" }],
      distinct: ["accountId"],
      select: {
        runId: true,
        accountId: true,
        survivalSec: true,
        points: true,
        style: true,
        level: true,
        startingWeaponId: true,
        enemiesKilled: true,
        account: { select: { displayName: true, photoUrl: true, testerAt: true, supporterAt: true } },
      },
    });
    return rows.map((row) => ({
      runId: row.runId,
      accountId: row.accountId,
      displayName: row.account.displayName,
      photoUrl: row.account.photoUrl,
      ...(row.account.testerAt === null ? {} : { tester: true as const }),
      ...(row.account.supporterAt === null ? {} : { supporter: true as const }),
      survivalSec: row.survivalSec ?? 0,
      points: row.points,
      style: row.style,
      level: row.level ?? 1,
      startingWeaponId: row.startingWeaponId,
      enemiesKilled: row.enemiesKilled ?? 0,
    }));
  }

  async rewardOf(seasonKey: string, accountId: string): Promise<RewardRow | null> {
    const row = await this.prisma.seasonReward.findUnique({ where: { seasonKey_accountId: { seasonKey, accountId } } });
    return row === null ? null : toRewardRow(row);
  }

  async pendingRewards(accountId: string): Promise<RewardRow[]> {
    const rows = await this.prisma.seasonReward.findMany({ where: { accountId, status: "pending" }, orderBy: { seasonKey: "desc" } });
    return rows.map(toRewardRow);
  }

  async markClaimed(seasonKey: string, accountId: string, at: Date): Promise<boolean> {
    // Условие — в самом обновлении: два нажатия разом забирают награду однажды.
    const { count } = await this.prisma.seasonReward.updateMany({ where: { seasonKey, accountId, status: "pending" }, data: { status: "claimed", claimedAt: at } });
    return count === 1;
  }

  async history(accountId: string, limit: number): Promise<HistoryRow[]> {
    const seasons = await this.prisma.season.findMany({
      where: { OR: [{ results: { some: { accountId } } }, { rewards: { some: { accountId } } }] },
      orderBy: { seasonKey: "desc" },
      take: limit,
      include: { results: { where: { accountId } }, rewards: { where: { accountId } } },
    });
    return seasons.map((season) => {
      const reward = season.rewards[0];
      return {
        seasonKey: season.seasonKey,
        startsAt: season.startsAt,
        endsAt: season.endsAt,
        results: season.results
          .map((result) => ({ difficulty: result.difficulty, bestSec: result.bestSec, place: result.place, boardSize: result.boardSize, division: divisionOfColumn(result.division) }))
          .sort((left, right) => DIFFICULTIES.indexOf(left.difficulty) - DIFFICULTIES.indexOf(right.difficulty)),
        reward: reward === undefined ? null : { coins: reward.coins, prestige: reward.prestige, claimed: reward.status === "claimed" },
      };
    });
  }
}

/**
 * Окно недели и только законченные забеги. Нижняя граница — позже из двух:
 * начала недели и отсечки рейтинга; отсечка после конца недели даёт пустое
 * окно, а не ошибку.
 */
export function windowOf(season: Season, since: Date | null) {
  const from = since !== null && since.getTime() > season.startsAt.getTime() ? since : season.startsAt;
  return { status: "finished" as const, finishedAt: { gte: from, lt: season.endsAt } };
}

/** Сезон по очкам берёт только забеги с очками: пролог и недосчитанные в нём не стоят. */
function scoredWhere(scoring: Scoring) {
  return scoring === "points" ? { points: { not: null } } : {};
}

function scoreOrder(scoring: Scoring) {
  return scoring === "points" ? ({ points: "desc" } as const) : ({ survivalSec: "desc" } as const);
}

function toRewardRow(row: { seasonKey: string; kind: string; difficulty: Difficulty | null; place: number | null; coins: number; prestige: number; status: string }): RewardRow {
  return {
    seasonKey: row.seasonKey,
    // Колонки — строки с проверкой в базе; незнакомое значение читается безопасно, а не роняет чтение.
    kind: row.kind === "place" ? "place" : "threshold",
    difficulty: row.difficulty,
    place: row.place,
    coins: row.coins,
    prestige: row.prestige,
    status: row.status === "claimed" ? "claimed" : "pending",
  };
}

/** Колонка — строка без проверки в базе: незнакомое значение читается как «дивизиона нет», а не роняет историю. */
function divisionOfColumn(value: string | null): Division | null {
  return DIVISIONS.find((division) => division === value) ?? null;
}
