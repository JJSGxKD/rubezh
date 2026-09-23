import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { Difficulty } from "./run-rules.js";
import type { RunVerdict, VerdictReason } from "./run-verdict.js";

/**
 * Забеги в Postgres (docs/34-stage3-plan.md, WP4). Запрос к базе живёт здесь,
 * а не в сервисе (docs/15-engineering-standards.md §2.3).
 *
 * Идемпотентность — первичным ключом `run_id`, а не проверкой в коде: два
 * одновременных итога одного забега упираются в базу, и прошедшим считается
 * ровно один (docs/15-engineering-standards.md §4.1).
 */

export interface RunStartRecord {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  startingWeaponId: string;
  contentHash: string;
  startedAt: Date | null;
}

export interface RunFinishRecord {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  startingWeaponId: string;
  contentHash: string;
  finishedAt: Date;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  weapons: { id: string; level: number }[];
  deathCause: string | null;
  cheats: boolean;
  ranked: boolean;
  verdict: RunVerdict;
  verdictReasons: VerdictReason[];
}

export interface StoredRun {
  runId: string;
  accountId: string;
  status: "started" | "finished";
  difficulty: Difficulty;
  startedAt: Date | null;
  /** записанное время выживания; `null` — забег ещё не закончен */
  survivalSec: number | null;
  verdict: RunVerdict | null;
  ranked: boolean;
}

/** `foreign` — забег с таким ключом уже принадлежит другому аккаунту. */
export type StartOutcome = "created" | "exists" | "foreign";
export type FinishOutcome = "finished" | "duplicate" | "foreign";

export interface RecentRun {
  difficulty: Difficulty;
  survivalSec: number;
  level: number;
  startingWeaponId: string;
  finishedAt: Date;
}

export interface BestRunRow {
  accountId: string;
  displayName: string;
  photoUrl: string | null;
  survivalSec: number;
  level: number;
  startingWeaponId: string;
  enemiesKilled: number;
}

export interface ReviewRow {
  runId: string;
  accountId: string;
  verdict: RunVerdict;
  verdictReasons: string[];
  difficulty: Difficulty;
  survivalSec: number | null;
  level: number | null;
  enemiesKilled: number | null;
  finishedAt: Date | null;
}

export const RUNS_REPOSITORY = Symbol("RUNS_REPOSITORY");

export interface RunsRepository {
  find(runId: string): Promise<StoredRun | null>;
  start(record: RunStartRecord): Promise<StartOutcome>;
  finish(record: RunFinishRecord): Promise<FinishOutcome>;
  stats(accountId: string): Promise<{ runs: number; totalKills: number; totalSurvivalSec: number }>;
  recent(accountId: string, limit: number): Promise<RecentRun[]>;
  /** Лучший рейтинговый забег каждого из аккаунтов — для строк лидерборда */
  bestRuns(accountIds: readonly string[], difficulty: Difficulty): Promise<BestRunRow[]>;
  /** Лучшее рейтинговое время каждого аккаунта — источник пересборки проекции */
  bestTimes(difficulty: Difficulty): Promise<{ accountId: string; survivalSec: number }[]>;
  review(limit: number): Promise<ReviewRow[]>;
}

@Injectable()
export class PrismaRunsRepository implements RunsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(runId: string): Promise<StoredRun | null> {
    const row = await this.prisma.run.findUnique({
      where: { runId },
      select: {
        runId: true,
        accountId: true,
        status: true,
        difficulty: true,
        startedAt: true,
        survivalSec: true,
        verdict: true,
        ranked: true,
      },
    });
    return row;
  }

  async start(record: RunStartRecord): Promise<StartOutcome> {
    try {
      await this.prisma.run.create({ data: { ...record, status: "started", verdictReasons: [] } });
      return "created";
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      // Повтор старта из очереди — не ошибка. Чужой ключ — ошибка.
      const existing = await this.find(record.runId);
      return existing?.accountId === record.accountId ? "exists" : "foreign";
    }
  }

  async finish(record: RunFinishRecord): Promise<FinishOutcome> {
    const existing = await this.find(record.runId);
    if (existing !== null && existing.accountId !== record.accountId) return "foreign";
    if (existing?.status === "finished") return "duplicate";

    const finished = {
      status: "finished" as const,
      finishedAt: record.finishedAt,
      outcome: record.outcome,
      survivalSec: record.survivalSec,
      level: record.level,
      enemiesKilled: record.enemiesKilled,
      weapons: record.weapons,
      deathCause: record.deathCause,
      cheats: record.cheats,
      ranked: record.ranked,
      verdict: record.verdict,
      verdictReasons: record.verdictReasons,
    };

    if (existing !== null) {
      // Условие на статус — защита от гонки: из двух одновременных итогов
      // обновит строку ровно один, второй увидит ноль и станет повтором.
      const updated = await this.prisma.run.updateMany({
        where: { runId: record.runId, accountId: record.accountId, status: "started" },
        data: finished,
      });
      return updated.count === 1 ? "finished" : "duplicate";
    }

    try {
      await this.prisma.run.create({
        data: {
          runId: record.runId,
          accountId: record.accountId,
          difficulty: record.difficulty,
          startingWeaponId: record.startingWeaponId,
          contentHash: record.contentHash,
          startedAt: null,
          ...finished,
        },
      });
      return "finished";
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.find(record.runId);
      return raced?.accountId === record.accountId ? "duplicate" : "foreign";
    }
  }

  async stats(accountId: string): Promise<{ runs: number; totalKills: number; totalSurvivalSec: number }> {
    // Считает база, а не выгрузка строк в память (docs/13-reuse-from-vpnsibcom.md §7).
    const aggregate = await this.prisma.run.aggregate({
      where: { accountId, status: "finished" },
      _count: { _all: true },
      _sum: { enemiesKilled: true, survivalSec: true },
    });
    return {
      runs: aggregate._count._all,
      totalKills: aggregate._sum.enemiesKilled ?? 0,
      totalSurvivalSec: aggregate._sum.survivalSec ?? 0,
    };
  }

  async recent(accountId: string, limit: number): Promise<RecentRun[]> {
    const rows = await this.prisma.run.findMany({
      where: { accountId, status: "finished" },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: { difficulty: true, survivalSec: true, level: true, startingWeaponId: true, finishedAt: true },
    });
    return rows.map((row) => ({
      difficulty: row.difficulty,
      survivalSec: row.survivalSec ?? 0,
      level: row.level ?? 1,
      startingWeaponId: row.startingWeaponId,
      finishedAt: row.finishedAt ?? new Date(0),
    }));
  }

  async bestRuns(accountIds: readonly string[], difficulty: Difficulty): Promise<BestRunRow[]> {
    if (accountIds.length === 0) return [];
    // Один запрос на всю страницу, а не по запросу на строку: `distinct` с
    // сортировкой по времени берёт лучший забег каждого аккаунта.
    const rows = await this.prisma.run.findMany({
      where: { accountId: { in: [...accountIds] }, difficulty, ranked: true },
      orderBy: [{ accountId: "asc" }, { survivalSec: "desc" }],
      distinct: ["accountId"],
      select: {
        accountId: true,
        survivalSec: true,
        level: true,
        startingWeaponId: true,
        enemiesKilled: true,
        account: { select: { displayName: true, photoUrl: true } },
      },
    });
    return rows.map((row) => ({
      accountId: row.accountId,
      displayName: row.account.displayName,
      photoUrl: row.account.photoUrl,
      survivalSec: row.survivalSec ?? 0,
      level: row.level ?? 1,
      startingWeaponId: row.startingWeaponId,
      enemiesKilled: row.enemiesKilled ?? 0,
    }));
  }

  async bestTimes(difficulty: Difficulty): Promise<{ accountId: string; survivalSec: number }[]> {
    const rows = await this.prisma.run.groupBy({
      by: ["accountId"],
      where: { difficulty, ranked: true },
      _max: { survivalSec: true },
    });
    return rows.map((row) => ({ accountId: row.accountId, survivalSec: row._max.survivalSec ?? 0 }));
  }

  async review(limit: number): Promise<ReviewRow[]> {
    const rows = await this.prisma.run.findMany({
      where: { verdict: { in: ["suspicious", "rejected"] } },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: {
        runId: true,
        accountId: true,
        verdict: true,
        verdictReasons: true,
        difficulty: true,
        survivalSec: true,
        level: true,
        enemiesKilled: true,
        finishedAt: true,
      },
    });
    return rows.map((row) => ({ ...row, verdict: row.verdict ?? "suspicious" }));
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
