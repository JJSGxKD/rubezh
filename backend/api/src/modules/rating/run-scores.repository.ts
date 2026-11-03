import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { ratedWhere } from "../runs/rated-runs.js";
import { storedDetailsSchema } from "../runs/run-details.js";
import { storedScoreInputSchema, type StoredScore, type StoredScoreInput } from "./score-types.js";

/**
 * Забеги для пересчёта очков (tasks/T-0293): чтение страницами по ключу и
 * запись очков. Запрос к базе живёт здесь, а не в команде
 * (docs/15-engineering-standards.md §2.3).
 */

/** Забег с тем, что нужно подсчёту, — из колонок строки, а не из тела запроса, которого уже нет. */
export interface RescoreRow {
  runId: string;
  survivalSec: number;
  enemiesKilled: number;
  /** `null` — счётчика нет в строке (забег до листа забега) */
  damageTaken: number | null;
  contentHash: string;
  /** `null` — забег записан до очков или клиентом без этих полей */
  scoreInput: StoredScoreInput | null;
}

export interface RunScoresRepository {
  /** Законченные рейтинговые забеги после ключа `after` по возрастанию ключа. */
  page(after: string | null, since: Date | null, limit: number): Promise<RescoreRow[]>;
  /** Записать очки пачки одной транзакцией. */
  save(scores: readonly { runId: string; score: StoredScore }[]): Promise<void>;
}

export const RUN_SCORES_REPOSITORY = Symbol("RUN_SCORES_REPOSITORY");

@Injectable()
export class PrismaRunScoresRepository implements RunScoresRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async page(after: string | null, since: Date | null, limit: number): Promise<RescoreRow[]> {
    const rows = await this.prisma.run.findMany({
      where: { status: "finished", survivalSec: { not: null }, enemiesKilled: { not: null }, ...ratedWhere(since), ...(after === null ? {} : { runId: { gt: after } }) },
      orderBy: { runId: "asc" },
      take: limit,
      select: { runId: true, survivalSec: true, enemiesKilled: true, details: true, contentHash: true, scoreInput: true },
    });
    return rows.map((row) => {
      const details = storedDetailsSchema.safeParse(row.details);
      const input = storedScoreInputSchema.safeParse(row.scoreInput);
      return {
        runId: row.runId,
        survivalSec: row.survivalSec ?? 0,
        enemiesKilled: row.enemiesKilled ?? 0,
        damageTaken: details.success ? details.data.damageTaken : null,
        contentHash: row.contentHash,
        scoreInput: input.success ? input.data : null,
      };
    });
  }

  async save(scores: readonly { runId: string; score: StoredScore }[]): Promise<void> {
    if (scores.length === 0) return;
    await this.prisma.$transaction(scores.map(({ runId, score }) => this.prisma.run.update({ where: { runId }, data: { points: score.points, axes: score.axes, style: score.style, band: score.band } })));
  }
}
