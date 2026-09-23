import type { LeaderboardEntry, LeaderboardStore } from "../../src/modules/runs/leaderboard.store.js";
import type { Difficulty } from "../../src/modules/runs/run-rules.js";
import type {
  BestRunRow,
  FinishOutcome,
  RecentRun,
  ReviewRow,
  RunFinishRecord,
  RunsRepository,
  RunStartRecord,
  StartOutcome,
  StoredRun,
} from "../../src/modules/runs/runs.repository.js";

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
        difficulty: row.difficulty,
        survivalSec: row.survivalSec,
        level: row.level,
        startingWeaponId: row.startingWeaponId,
        finishedAt: row.finishedAt,
      }));
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
  private readonly boards = new Map<Difficulty, Map<string, number>>();

  async submit(difficulty: Difficulty, accountId: string, survivalSec: number): Promise<{ improved: boolean }> {
    if (this.failSubmit) throw new Error("Redis недоступен");
    const board = this.board(difficulty);
    const previous = board.get(accountId);
    if (previous !== undefined && previous >= survivalSec) return { improved: false };
    board.set(accountId, survivalSec);
    return { improved: true };
  }

  async rank(difficulty: Difficulty, accountId: string): Promise<number | null> {
    const index = this.sorted(difficulty).findIndex((entry) => entry.accountId === accountId);
    return index < 0 ? null : index + 1;
  }

  async best(difficulty: Difficulty, accountId: string): Promise<number | null> {
    return this.board(difficulty).get(accountId) ?? null;
  }

  async top(difficulty: Difficulty, limit: number): Promise<LeaderboardEntry[]> {
    return this.sorted(difficulty).slice(0, limit);
  }

  async count(difficulty: Difficulty): Promise<number> {
    return this.board(difficulty).size;
  }

  async replace(difficulty: Difficulty, entries: readonly LeaderboardEntry[]): Promise<void> {
    this.boards.set(difficulty, new Map(entries.map((entry) => [entry.accountId, entry.survivalSec])));
  }

  private board(difficulty: Difficulty): Map<string, number> {
    let board = this.boards.get(difficulty);
    if (board === undefined) {
      board = new Map();
      this.boards.set(difficulty, board);
    }
    return board;
  }

  private sorted(difficulty: Difficulty): LeaderboardEntry[] {
    return [...this.board(difficulty).entries()]
      .map(([accountId, survivalSec]) => ({ accountId, survivalSec }))
      .sort((left, right) => right.survivalSec - left.survivalSec);
  }
}
