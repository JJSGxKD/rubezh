import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { BestRunRow } from "../runs/runs.repository.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
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

export interface HistoryRow {
  seasonKey: string;
  startsAt: Date;
  endsAt: Date;
  results: SeasonResultLine[];
  reward: { coins: number; prestige: number; claimed: boolean } | null;
}

export const SEASONS_REPOSITORY = Symbol("SEASONS_REPOSITORY");

export interface SeasonsRepository {
  /** Лучшее рейтинговое время каждого аккаунта за неделю — источник пересборки живой таблицы. */
  weekBests(difficulty: Difficulty, season: Season, excluded: readonly string[]): Promise<{ accountId: string; survivalSec: number }[]>;
  /**
   * Лучший забег аккаунта за неделю. `shadow` — вместе со сданными под
   * молчаливым ограничением рейтинга: так игрок видит себя сам.
   */
  bestRun(accountId: string, difficulty: Difficulty, season: Season, shadow: boolean): Promise<{ survivalSec: number } | null>;
  /** Лучший забег недели каждого из аккаунтов — для строк таблицы, одним запросом на страницу. */
  boardRuns(accountIds: readonly string[], difficulty: Difficulty, season: Season): Promise<BestRunRow[]>;
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

  async weekBests(difficulty: Difficulty, season: Season, excluded: readonly string[]): Promise<{ accountId: string; survivalSec: number }[]> {
    const rows = await this.prisma.run.groupBy({
      by: ["accountId"],
      where: { ...windowOf(season), difficulty, ranked: true, accountId: { notIn: [...excluded] } },
      _max: { survivalSec: true },
    });
    return rows.map((row) => ({ accountId: row.accountId, survivalSec: row._max.survivalSec ?? 0 }));
  }

  async bestRun(accountId: string, difficulty: Difficulty, season: Season, shadow: boolean): Promise<{ survivalSec: number } | null> {
    const row = await this.prisma.run.findFirst({
      where: { ...windowOf(season), accountId, difficulty, OR: shadow ? [{ ranked: true }, { ratingRestricted: "silent" }] : [{ ranked: true }] },
      orderBy: [{ survivalSec: "desc" }, { finishedAt: "asc" }],
      select: { survivalSec: true },
    });
    return row === null ? null : { survivalSec: row.survivalSec ?? 0 };
  }

  async boardRuns(accountIds: readonly string[], difficulty: Difficulty, season: Season): Promise<BestRunRow[]> {
    if (accountIds.length === 0) return [];
    // `distinct` с сортировкой по времени берёт лучший забег недели каждого аккаунта.
    const rows = await this.prisma.run.findMany({
      where: { ...windowOf(season), accountId: { in: [...accountIds] }, difficulty, ranked: true },
      orderBy: [{ accountId: "asc" }, { survivalSec: "desc" }, { finishedAt: "asc" }],
      distinct: ["accountId"],
      select: {
        accountId: true,
        survivalSec: true,
        level: true,
        startingWeaponId: true,
        enemiesKilled: true,
        account: { select: { displayName: true, photoUrl: true, testerAt: true } },
      },
    });
    return rows.map((row) => ({
      accountId: row.accountId,
      displayName: row.account.displayName,
      photoUrl: row.account.photoUrl,
      ...(row.account.testerAt === null ? {} : { tester: true as const }),
      survivalSec: row.survivalSec ?? 0,
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
          .map((result) => ({ difficulty: result.difficulty, bestSec: result.bestSec, place: result.place, boardSize: result.boardSize }))
          .sort((left, right) => DIFFICULTIES.indexOf(left.difficulty) - DIFFICULTIES.indexOf(right.difficulty)),
        reward: reward === undefined ? null : { coins: reward.coins, prestige: reward.prestige, claimed: reward.status === "claimed" },
      };
    });
  }
}

/** Окно недели и только законченные забеги. */
function windowOf(season: Season) {
  return { status: "finished" as const, finishedAt: { gte: season.startsAt, lt: season.endsAt } };
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
