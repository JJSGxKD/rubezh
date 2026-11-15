import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { storedScoreOf, storedScoreInputSchema, type StoredScore, type StoredScoreInput } from "../rating/score-types.js";
import { storedDetailsSchema, storedWeaponsSchema, type StoredDetails } from "./run-details.js";
import { reviewOutcomeOf, type ReviewOutcome } from "./run-review-rules.js";
import type { Difficulty, RunMode } from "./run-rules.js";
import type { RunVerdict } from "./run-verdict.js";
import type { RatingRestricted } from "./runs.repository.js";

/**
 * Отчёт забега и решение разбора в Postgres (Р203, tasks/T-0419). Отдельный
 * репозиторий: `runs.repository.ts` и так велик, а разбору нужны всего две
 * операции — прочитать забег целиком и условно записать решение.
 *
 * Запись решения — одно условное `updateMany` по забегу и допустимому прежнему
 * состоянию, а не «прочитал, проверил, записал»: два одновременных решения
 * упираются в базу, и прошедшим считается ровно одно
 * (docs/15-engineering-standards.md §4.1).
 */

/** Законченный забег со всем, что показывает отчёт. JSON-колонки уже разобраны схемами: битое — `null` в своём поле. */
export interface RunReportRow {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  mode: RunMode;
  startedAt: Date | null;
  finishedAt: Date;
  outcome: "died" | "abandoned" | null;
  survivalSec: number | null;
  level: number | null;
  enemiesKilled: number | null;
  deathCause: string | null;
  weapons: { id: string; level: number; damage: number | null }[];
  details: StoredDetails | null;
  /** секунда каждого второго шанса */
  continues: number[];
  cheats: boolean;
  contentHash: string;
  rubezhReached: boolean;
  rubezhClearedSec: number | null;
  verdict: RunVerdict | null;
  verdictReasons: string[];
  ranked: boolean;
  ratingRestricted: RatingRestricted | null;
  score: StoredScore | null;
  scoreInput: StoredScoreInput | null;
  reviewOutcome: ReviewOutcome | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

export const RUN_REVIEW_REPOSITORY = Symbol("RUN_REVIEW_REPOSITORY");

export interface RunReviewRepository {
  /** Законченный забег целиком; незнакомый и незаконченный — `null`. */
  report(runId: string): Promise<RunReportRow | null>;
  /**
   * Записать решение, если забег сейчас в одном из допустимых прежних
   * состояний; `true` — строка обновлена. `false` — забега нет, он не закончен
   * или состояние уже другое: вызывающий перечитывает строку и решает заново.
   */
  mark(runId: string, outcome: ReviewOutcome, from: readonly (ReviewOutcome | null)[], actorId: string, at: Date): Promise<boolean>;
}

@Injectable()
export class PrismaRunReviewRepository implements RunReviewRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async report(runId: string): Promise<RunReportRow | null> {
    const row = await this.prisma.run.findFirst({ where: { runId, status: "finished" } });
    if (row === null || row.finishedAt === null) return null;
    const weapons = storedWeaponsSchema.safeParse(row.weapons);
    const details = storedDetailsSchema.safeParse(row.details);
    const scoreInput = storedScoreInputSchema.safeParse(row.scoreInput);
    return {
      runId: row.runId,
      accountId: row.accountId,
      difficulty: row.difficulty,
      mode: row.mode,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      outcome: row.outcome,
      survivalSec: row.survivalSec,
      level: row.level,
      enemiesKilled: row.enemiesKilled,
      deathCause: row.deathCause,
      // Битый JSON — без этой части, а не без отчёта целиком.
      weapons: weapons.success ? weapons.data.map((weapon) => ({ id: weapon.id, level: weapon.level, damage: weapon.damage ?? null })) : [],
      details: details.success ? details.data : null,
      continues: row.continues,
      cheats: row.cheats,
      contentHash: row.contentHash,
      rubezhReached: row.rubezhReached,
      rubezhClearedSec: row.rubezhClearedSec,
      verdict: row.verdict,
      verdictReasons: row.verdictReasons,
      ranked: row.ranked,
      ratingRestricted: row.ratingRestricted === "notified" || row.ratingRestricted === "silent" ? row.ratingRestricted : null,
      score: storedScoreOf({ points: row.points, axes: row.axes, style: row.style, band: row.band }),
      scoreInput: scoreInput.success ? scoreInput.data : null,
      reviewOutcome: reviewOutcomeOf(row.reviewOutcome),
      reviewedAt: row.reviewedAt,
      reviewedBy: row.reviewedBy,
    };
  }

  async mark(runId: string, outcome: ReviewOutcome, from: readonly (ReviewOutcome | null)[], actorId: string, at: Date): Promise<boolean> {
    // `null` в фильтре — отдельное условие: `in` и `NOT` с `null` Prisma не принимает.
    const previous: Prisma.RunWhereInput[] = from.map((state) => ({ reviewOutcome: state }));
    const { count } = await this.prisma.run.updateMany({
      where: { runId, status: "finished", OR: previous },
      data: { reviewOutcome: outcome, reviewedAt: at, reviewedBy: actorId },
    });
    return count === 1;
  }
}
