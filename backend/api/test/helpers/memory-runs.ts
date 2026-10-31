import type { Redis } from "ioredis";
import { loadAppConfig } from "../../src/config/app-config.js";
import { RestrictionsHooks } from "../../src/modules/restrictions/restrictions-hooks.js";
import type { Board, LeaderboardEntry, LeaderboardStore } from "../../src/modules/runs/leaderboard.store.js";
import { RatingRestrictions } from "../../src/modules/runs/rating-restrictions.js";
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
import { AUTH_ENV } from "./auth-env.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./memory-restrictions.js";

/**
 * Забеги и рейтинг в памяти — для тестов сервиса. Смысл тот же, что у
 * реализаций на Postgres и Redis: повтор ключа не создаёт вторую запись,
 * лучшее время только растёт. Сами реализации проверяются на живых базах.
 */

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
      survivalSec: row.survivalSec,
      verdict: row.verdict,
      ranked: row.ranked,
      ratingRestricted: row.ratingRestricted,
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
      survivalSec: null,
      verdict: null,
      ranked: false,
      ratingRestricted: null,
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
      survivalSec: record.survivalSec,
      verdict: record.verdict,
      ranked: record.ranked,
      ratingRestricted: record.ratingRestricted,
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

  async bestRuns(accountIds: readonly string[], difficulty: Difficulty): Promise<BestRunRow[]> {
    return accountIds.flatMap((accountId) => {
      const best = this.rankedOf(difficulty).filter((row) => row.accountId === accountId).sort((a, b) => b.survivalSec - a.survivalSec)[0];
      if (best === undefined) return [];
      return [{ accountId, displayName: `игрок ${accountId.slice(0, 4)}`, photoUrl: null, survivalSec: best.survivalSec, level: best.level, startingWeaponId: best.startingWeaponId, enemiesKilled: best.enemiesKilled }];
    });
  }

  async bestTimes(difficulty: Difficulty): Promise<{ accountId: string; survivalSec: number }[]> {
    const best = new Map<string, number>();
    for (const row of this.rankedOf(difficulty)) best.set(row.accountId, Math.max(best.get(row.accountId) ?? 0, row.survivalSec));
    return [...best.entries()].map(([accountId, survivalSec]) => ({ accountId, survivalSec }));
  }

  async bestRunOf(accountId: string, difficulty: Difficulty, shadow: boolean): Promise<BestRunRow | null> {
    const counted = [...this.rows.values()].flatMap((row) =>
      row.record !== undefined && row.accountId === accountId && row.record.difficulty === difficulty && (row.record.ranked || (shadow && row.record.ratingRestricted === "silent")) ? [row.record] : [],
    );
    const best = counted.sort((a, b) => b.survivalSec - a.survivalSec)[0];
    if (best === undefined) return null;
    return { accountId, displayName: `игрок ${accountId.slice(0, 4)}`, photoUrl: null, survivalSec: best.survivalSec, level: best.level, startingWeaponId: best.startingWeaponId, enemiesKilled: best.enemiesKilled };
  }

  async moderationRuns(accountId: string, difficulty: Difficulty, limit: number): Promise<ModerationRunRow[]> {
    return [...this.rows.values()]
      .flatMap((row) => (row.record !== undefined && row.accountId === accountId && row.record.difficulty === difficulty && (row.ranked || this.unrankedByModerator(row)) ? [{ ...row.record, ranked: row.ranked }] : []))
      .sort((a, b) => b.survivalSec - a.survivalSec)
      .slice(0, limit)
      .map((record) => ({ runId: record.runId, difficulty: record.difficulty, survivalSec: record.survivalSec, level: record.level, enemiesKilled: record.enemiesKilled, startingWeaponId: record.startingWeaponId, finishedAt: record.finishedAt, ranked: record.ranked }));
  }

  async setRanked(runId: string, ranked: boolean): Promise<{ accountId: string; difficulty: Difficulty; survivalSec: number } | null> {
    const row = this.rows.get(runId);
    if (row?.record === undefined || (ranked ? !this.unrankedByModerator(row) : !row.ranked)) return null;
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

  private finishedOf(accountId: string): RunFinishRecord[] {
    return [...this.rows.values()].flatMap((row) => (row.record !== undefined && row.accountId === accountId ? [row.record] : []));
  }

  private rankedOf(difficulty: Difficulty): RunFinishRecord[] {
    return [...this.rows.values()].flatMap((row) => (row.record?.ranked === true && row.record.difficulty === difficulty ? [row.record] : []));
  }
}

export class MemoryLeaderboardStore implements LeaderboardStore {
  /** запись в рейтинг падает — так проверяется, что повтор итога его допишет */
  failSubmit = false;
  /** по доске и сложности, как два ключа в Redis: правила те же, что у `RedisLeaderboardStore` */
  private readonly boards = new Map<string, Map<string, number>>();

  async submit(difficulty: Difficulty, accountId: string, survivalSec: number, boards: readonly Board[]): Promise<{ improved: boolean }> {
    if (this.failSubmit) throw new Error("Redis недоступен");
    let improved = false;
    for (const side of boards) {
      const board = this.board(difficulty, side);
      const previous = board.get(accountId);
      if (previous !== undefined && previous >= survivalSec) continue;
      board.set(accountId, survivalSec);
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
    return this.sorted(difficulty, side).slice(0, limit);
  }

  async count(difficulty: Difficulty, side: Board): Promise<number> {
    return this.board(difficulty, side).size;
  }

  async countAbove(difficulty: Difficulty, survivalSec: number, side: Board): Promise<number> {
    return [...this.board(difficulty, side).values()].filter((score) => score > survivalSec).length;
  }

  async set(difficulty: Difficulty, accountId: string, survivalSec: number | null, boards: readonly Board[]): Promise<void> {
    for (const side of boards) {
      if (survivalSec === null) this.board(difficulty, side).delete(accountId);
      else this.board(difficulty, side).set(accountId, survivalSec);
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
    this.boards.set(`${side}:${difficulty}`, new Map(entries.map((entry) => [entry.accountId, entry.survivalSec])));
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
      .map(([accountId, survivalSec]) => ({ accountId, survivalSec }))
      .sort((left, right) => right.survivalSec - left.survivalSec);
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

/** Рейтинг под ограничениями поверх памяти: ограничения кладёт тест — в `restrictions`. */
export function ratingRestrictions(runs: RunsRepository, board: LeaderboardStore, restrictions = new MemoryRestrictionsRepository()) {
  const gate = restrictionsGate(restrictions);
  const hooks = new RestrictionsHooks();
  const lock = new MemoryLock();
  const rating = new RatingRestrictions(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), lock as unknown as Redis, runs, board, gate, hooks);
  rating.onModuleInit();
  return { rating, gate, hooks, restrictions, lock };
}
