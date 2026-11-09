import type { Redis } from "ioredis";
import type { RunScorer } from "../../src/modules/rating/run-scorer.service.js";
import type { StoredScore } from "../../src/modules/rating/score-types.js";
import { loadAppConfig } from "../../src/config/app-config.js";
import { RestrictionsHooks } from "../../src/modules/restrictions/restrictions-hooks.js";
import type { Board, LeaderboardEntry, LeaderboardStore } from "../../src/modules/runs/leaderboard.store.js";
import { RatingRestrictions } from "../../src/modules/runs/rating-restrictions.js";
import { isRatedRun } from "../../src/modules/runs/rated-runs.js";
import { DIFFICULTIES, type Difficulty } from "../../src/modules/runs/run-rules.js";
import type {
  BestRunRow,
  FinishOutcome,
  ModerationRunRow,
  RecentRun,
  ReviewRow,
  RunDetailRow,
  RunFinishRecord,
  RunsRepository,
  RunStartRecord,
  StartOutcome,
  StoredRun,
} from "../../src/modules/runs/runs.repository.js";
import type { SettingsReader } from "../../src/modules/settings/settings.service.js";
import { AUTH_ENV } from "./auth-env.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./memory-restrictions.js";
import { panelSettings } from "./settings.js";

/**
 * Забеги и рейтинг в памяти — для тестов сервиса. Смысл тот же, что у
 * реализаций на Postgres и Redis: повтор ключа не создаёт вторую запись,
 * лучший счёт только растёт. Сами реализации проверяются на живых базах.
 *
 * Доска всех времён ранжирует по очкам (tasks/T-0294): забег без очков в ней не
 * стоит. Сервису для очков нужен подсчёт — в тестах это `survivalScorer()`:
 * очки равны секундам, поэтому порядок по очкам совпадает с порядком по времени.
 */

/** Очки в памяти: записанные у забега или `null`. */
function pointsOf(record: RunFinishRecord): number | null {
  return record.score?.points ?? null;
}

/** Очки забега, равные его секундам, — запись `score` в строку для тестов доски. */
export function secondsScore(survivalSec: number): StoredScore {
  return { points: Math.round(survivalSec), axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "t", band: "average" };
}

/**
 * Подсчёт очков для тестов доски: очки равны секундам выживания. Остальное, что
 * умеет настоящий `RunScorer`, этим тестам не нужно.
 */
export function survivalScorer(): RunScorer {
  const scorer: Pick<RunScorer, "score" | "announce" | "expectedPointsFor"> = {
    score: (input) => ({ points: Math.round(input.survivalSec), axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "t", band: "average", expectedPoints: 0, outOfRange: false }),
    announce: async () => {},
    expectedPointsFor: () => 0,
  };
  return scorer as RunScorer;
}

interface Row extends StoredRun {
  record?: RunFinishRecord;
}

export class MemoryRunsRepository implements RunsRepository {
  readonly rows = new Map<string, Row>();

  async find(runId: string): Promise<StoredRun | null> {
    const row = this.rows.get(runId);
    if (row === undefined) return null;
    return {
      runId: row.runId,
      accountId: row.accountId,
      status: row.status,
      difficulty: row.difficulty,
      startedAt: row.startedAt,
      finishedAt: row.record?.finishedAt ?? null,
      survivalSec: row.survivalSec,
      verdict: row.verdict,
      ranked: row.ranked,
      ratingRestricted: row.ratingRestricted,
      cheats: row.record?.cheats ?? false,
      rubezhReached: row.record?.rubezhReached ?? false,
      rubezhClearedSec: row.record?.rubezhClearedSec ?? null,
      score: row.record?.score ?? null,
    };
  }

  async start(record: RunStartRecord): Promise<StartOutcome> {
    const existing = this.rows.get(record.runId);
    if (existing !== undefined) return existing.accountId === record.accountId ? "exists" : "foreign";
    this.rows.set(record.runId, {
      runId: record.runId,
      accountId: record.accountId,
      status: "started",
      difficulty: record.difficulty,
      startedAt: record.startedAt,
      finishedAt: null,
      survivalSec: null,
      verdict: null,
      ranked: false,
      ratingRestricted: null,
      cheats: false,
      rubezhReached: false,
      rubezhClearedSec: null,
      score: null,
    });
    return "created";
  }

  async finish(record: RunFinishRecord): Promise<FinishOutcome> {
    const existing = this.rows.get(record.runId);
    if (existing !== undefined && existing.accountId !== record.accountId) return "foreign";
    if (existing?.status === "finished") return "duplicate";
    this.rows.set(record.runId, {
      runId: record.runId,
      accountId: record.accountId,
      status: "finished",
      difficulty: record.difficulty,
      startedAt: existing?.startedAt ?? null,
      finishedAt: record.finishedAt,
      survivalSec: record.survivalSec,
      verdict: record.verdict,
      ranked: record.ranked,
      ratingRestricted: record.ratingRestricted,
      cheats: record.cheats,
      rubezhReached: record.rubezhReached,
      rubezhClearedSec: record.rubezhClearedSec,
      score: record.score ?? null,
      record,
    });
    return "finished";
  }

  async stats(accountId: string): Promise<{ runs: number; totalKills: number; totalSurvivalSec: number }> {
    const finished = this.finishedOf(accountId);
    return {
      runs: finished.length,
      totalKills: finished.reduce((sum, row) => sum + row.enemiesKilled, 0),
      totalSurvivalSec: finished.reduce((sum, row) => sum + row.survivalSec, 0),
    };
  }

  async recent(accountId: string, limit: number): Promise<RecentRun[]> {
    return this.finishedOf(accountId)
      .sort((left, right) => right.finishedAt.getTime() - left.finishedAt.getTime())
      .slice(0, limit)
      .map((row) => ({
        runId: row.runId,
        difficulty: row.difficulty,
        survivalSec: row.survivalSec,
        level: row.level,
        startingWeaponId: row.startingWeaponId,
        finishedAt: row.finishedAt,
      }));
  }

  async detail(accountId: string, runId: string): Promise<RunDetailRow | null> {
    const record = this.rows.get(runId)?.record;
    if (record === undefined || record.accountId !== accountId) return null;
    return {
      runId: record.runId,
      difficulty: record.difficulty,
      startingWeaponId: record.startingWeaponId,
      finishedAt: record.finishedAt,
      outcome: record.outcome,
      survivalSec: record.survivalSec,
      level: record.level,
      enemiesKilled: record.enemiesKilled,
      weapons: record.weapons.map((weapon) => ({ id: weapon.id, level: weapon.level, damage: weapon.damage ?? null })),
      details: record.details,
      deathCause: record.deathCause,
      cheats: record.cheats,
      continues: record.continues.length,
      ranked: record.ranked,
      ratingRestricted: record.ratingRestricted,
      verdict: record.verdict,
    };
  }

  async bestRuns(accountIds: readonly string[], difficulty: Difficulty, since: Date | null): Promise<BestRunRow[]> {
    return accountIds.flatMap((accountId) => {
      const best = this.rankedOf(difficulty, since).filter((row) => row.accountId === accountId && pointsOf(row) !== null).sort((a, b) => (pointsOf(b) ?? 0) - (pointsOf(a) ?? 0))[0];
      if (best === undefined) return [];
      return [{ accountId, displayName: `игрок ${accountId.slice(0, 4)}`, photoUrl: null, survivalSec: best.survivalSec, points: pointsOf(best), style: best.score?.style ?? null, level: best.level, startingWeaponId: best.startingWeaponId, enemiesKilled: best.enemiesKilled }];
    });
  }

  async bestScores(difficulty: Difficulty, since: Date | null): Promise<{ accountId: string; score: number }[]> {
    const best = new Map<string, number>();
    for (const row of this.rankedOf(difficulty, since)) {
      const points = pointsOf(row);
      if (points !== null) best.set(row.accountId, Math.max(best.get(row.accountId) ?? 0, points));
    }
    return [...best.entries()].map(([accountId, score]) => ({ accountId, score }));
  }

  async bestRunOf(accountId: string, difficulty: Difficulty, shadow: boolean, since: Date | null): Promise<BestRunRow | null> {
    const counted = [...this.rows.values()].flatMap((row) =>
      row.record !== undefined &&
      row.accountId === accountId &&
      row.record.difficulty === difficulty &&
      isRatedRun(difficulty, row.record.finishedAt, since) &&
      pointsOf(row.record) !== null &&
      (row.record.ranked || (shadow && row.record.ratingRestricted === "silent"))
        ? [row.record]
        : [],
    );
    const best = counted.sort((a, b) => (pointsOf(b) ?? 0) - (pointsOf(a) ?? 0))[0];
    if (best === undefined) return null;
    return { accountId, displayName: `игрок ${accountId.slice(0, 4)}`, photoUrl: null, survivalSec: best.survivalSec, points: pointsOf(best), style: best.score?.style ?? null, level: best.level, startingWeaponId: best.startingWeaponId, enemiesKilled: best.enemiesKilled };
  }

  async moderationRuns(accountId: string, difficulty: Difficulty, limit: number, since: Date | null): Promise<ModerationRunRow[]> {
    return [...this.rows.values()]
      .flatMap((row) =>
        row.record !== undefined && row.accountId === accountId && row.record.difficulty === difficulty && isRatedRun(difficulty, row.record.finishedAt, since) && (row.ranked || this.unrankedByModerator(row))
          ? [{ ...row.record, ranked: row.ranked }]
          : [],
      )
      .sort((a, b) => b.survivalSec - a.survivalSec)
      .slice(0, limit)
      .map((record) => ({ runId: record.runId, difficulty: record.difficulty, survivalSec: record.survivalSec, points: pointsOf(record), level: record.level, enemiesKilled: record.enemiesKilled, startingWeaponId: record.startingWeaponId, finishedAt: record.finishedAt, ranked: record.ranked }));
  }

  async setRanked(runId: string, ranked: boolean, since: Date | null): Promise<{ accountId: string; difficulty: Difficulty; survivalSec: number } | null> {
    const row = this.rows.get(runId);
    if (row?.record === undefined || !isRatedRun(row.record.difficulty, row.record.finishedAt, since) || (ranked ? !this.unrankedByModerator(row) : !row.ranked)) return null;
    row.ranked = ranked;
    row.record = { ...row.record, ranked };
    return { accountId: row.accountId, difficulty: row.record.difficulty, survivalSec: row.record.survivalSec };
  }

  private unrankedByModerator(row: Row): boolean {
    return row.record !== undefined && !row.ranked && row.record.verdict === "ok" && !row.record.cheats && row.record.ratingRestricted === null;
  }

  async review(limit: number): Promise<ReviewRow[]> {
    return [...this.rows.values()]
      .flatMap((row) => (row.record !== undefined && row.record.verdict !== "ok" ? [row.record] : []))
      .slice(0, limit)
      .map((record) => ({
        runId: record.runId,
        accountId: record.accountId,
        verdict: record.verdict,
        verdictReasons: record.verdictReasons,
        difficulty: record.difficulty,
        survivalSec: record.survivalSec,
        level: record.level,
        enemiesKilled: record.enemiesKilled,
        finishedAt: record.finishedAt,
      }));
  }

  async rubezhWinners(difficulty: Difficulty, since: Date | null, only?: readonly string[]): Promise<string[]> {
    const winners = this.rankedOf(difficulty, since).filter(
      (record) => record.verdict === "ok" && !record.cheats && record.rubezhReached && record.rubezhClearedSec !== null && (only === undefined || only.includes(record.accountId)),
    );
    return [...new Set(winners.map((record) => record.accountId))];
  }

  private finishedOf(accountId: string): RunFinishRecord[] {
    return [...this.rows.values()].flatMap((row) => (row.record !== undefined && row.accountId === accountId ? [row.record] : []));
  }

  /** Рейтинговые забеги сложности — то же условие, что `ratedWhere` в запросах Postgres. */
  private rankedOf(difficulty: Difficulty, since: Date | null): RunFinishRecord[] {
    return [...this.rows.values()].flatMap((row) => (row.record?.ranked === true && row.record.difficulty === difficulty && isRatedRun(difficulty, row.record.finishedAt, since) ? [row.record] : []));
  }
}

export class MemoryLeaderboardStore implements LeaderboardStore {
  /** запись в рейтинг падает — так проверяется, что повтор итога его допишет */
  failSubmit = false;
  /** по доске и сложности, как два ключа в Redis: правила те же, что у `RedisLeaderboardStore` */
  private readonly boards = new Map<string, Map<string, number>>();
  /** набор победителей над стражем по сложности, как `lb:rubezh:<сложность>` */
  private readonly winners = new Map<Difficulty, Set<string>>();

  async submit(difficulty: Difficulty, accountId: string, score: number, boards: readonly Board[], rubezh = false): Promise<{ improved: boolean }> {
    if (this.failSubmit) throw new Error("Redis недоступен");
    if (rubezh) this.winnersOf(difficulty).add(accountId);
    let improved = false;
    for (const side of boards) {
      const board = this.board(difficulty, side);
      const previous = board.get(accountId);
      if (previous !== undefined && previous >= score) continue;
      board.set(accountId, score);
      improved = true;
    }
    return { improved };
  }

  async rank(difficulty: Difficulty, accountId: string, side: Board): Promise<number | null> {
    const index = this.sorted(difficulty, side).findIndex((entry) => entry.accountId === accountId);
    return index < 0 ? null : index + 1;
  }

  async best(difficulty: Difficulty, accountId: string, side: Board): Promise<number | null> {
    return this.board(difficulty, side).get(accountId) ?? null;
  }

  async top(difficulty: Difficulty, limit: number, side: Board): Promise<LeaderboardEntry[]> {
    return this.sorted(difficulty, side)
      .slice(0, limit)
      .map((entry) => (this.winnersOf(difficulty).has(entry.accountId) ? { ...entry, rubezh: true as const } : entry));
  }

  async count(difficulty: Difficulty, side: Board): Promise<number> {
    return this.board(difficulty, side).size;
  }

  async countAbove(difficulty: Difficulty, score: number, side: Board): Promise<number> {
    return [...this.board(difficulty, side).values()].filter((other) => other > score).length;
  }

  async set(difficulty: Difficulty, accountId: string, score: number | null, boards: readonly Board[]): Promise<void> {
    for (const side of boards) {
      if (score === null) this.board(difficulty, side).delete(accountId);
      else this.board(difficulty, side).set(accountId, score);
    }
  }

  async remove(accountIds: readonly string[], boards: readonly Board[]): Promise<number> {
    let removed = 0;
    for (const side of boards) {
      for (const difficulty of DIFFICULTIES) {
        for (const accountId of accountIds) if (this.board(difficulty, side).delete(accountId)) removed += 1;
      }
    }
    return removed;
  }

  async replace(difficulty: Difficulty, side: Board, entries: readonly LeaderboardEntry[]): Promise<void> {
    this.boards.set(`${side}:${difficulty}`, new Map(entries.map((entry) => [entry.accountId, entry.score])));
  }

  async replaceRubezh(difficulty: Difficulty, accountIds: readonly string[]): Promise<void> {
    this.winners.set(difficulty, new Set(accountIds));
  }

  async setRubezh(difficulty: Difficulty, accountId: string, won: boolean): Promise<void> {
    if (won) this.winnersOf(difficulty).add(accountId);
    else this.winnersOf(difficulty).delete(accountId);
  }

  private winnersOf(difficulty: Difficulty): Set<string> {
    let set = this.winners.get(difficulty);
    if (set === undefined) {
      set = new Set();
      this.winners.set(difficulty, set);
    }
    return set;
  }

  private board(difficulty: Difficulty, side: Board): Map<string, number> {
    const name = `${side}:${difficulty}`;
    let board = this.boards.get(name);
    if (board === undefined) {
      board = new Map();
      this.boards.set(name, board);
    }
    return board;
  }

  private sorted(difficulty: Difficulty, side: Board): LeaderboardEntry[] {
    return [...this.board(difficulty, side).entries()]
      .map(([accountId, score]) => ({ accountId, score }))
      .sort((left, right) => right.score - left.score);
  }
}

/** Лок обхода в памяти: занят — как будто проходит соседняя реплика. */
export class MemoryLock {
  held = false;
  async set(): Promise<"OK" | null> {
    if (this.held) return null;
    this.held = true;
    return "OK";
  }
  async eval(): Promise<number> {
    this.held = false;
    return 1;
  }
}

/**
 * Рейтинг под ограничениями поверх памяти: ограничения кладёт тест — в
 * `restrictions`, настройки панели (отсечка `rating.since-date`) — в `settings`.
 */
export function ratingRestrictions(runs: RunsRepository, board: LeaderboardStore, restrictions = new MemoryRestrictionsRepository(), settings: SettingsReader = panelSettings()) {
  const gate = restrictionsGate(restrictions);
  const hooks = new RestrictionsHooks();
  const lock = new MemoryLock();
  const rating = new RatingRestrictions(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), lock as unknown as Redis, runs, board, gate, hooks, settings);
  rating.onModuleInit();
  return { rating, gate, hooks, restrictions, lock };
}
