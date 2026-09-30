import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Удвоение награды за забег в базе (docs/35-stage4-plan.md WP12, место
 * `run_double`): сессия показа привязывается к строке награды условным
 * `UPDATE`, поэтому забег удваивается одной сессией, а повтор той же —
 * дожимает начисление.
 */

export interface DoubleCandidate {
  runId: string;
  coinsCredited: number | null;
  skipped: string | null;
  createdAt: Date;
  doubleSessionId: string | null;
  doubledAt: Date | null;
}

export const RUN_DOUBLE_REPOSITORY = Symbol("RUN_DOUBLE_REPOSITORY");

export interface RunDoubleRepository {
  /** своя награда забега; `null` — строки ещё нет или забег чужой */
  candidate(runId: string, accountId: string): Promise<DoubleCandidate | null>;
  /** привязать сессию; `false` — забег уже удвоен другой сессией */
  attach(runId: string, accountId: string, sessionId: string): Promise<boolean>;
  markDoubled(runId: string, at: Date): Promise<void>;
}

const candidateSchema = z.object({
  run_id: z.string(),
  coins_credited: z.number().int().nullable(),
  skipped: z.string().nullable(),
  created_at: z.date(),
  double_session_id: z.string().nullable(),
  doubled_at: z.date().nullable(),
});

@Injectable()
export class PrismaRunDoubleRepository implements RunDoubleRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async candidate(runId: string, accountId: string): Promise<DoubleCandidate | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT run_id, coins_credited, skipped, created_at, double_session_id, doubled_at
      FROM run_reward WHERE run_id = ${runId} AND account_id = ${accountId}::uuid`;
    if (rows.length === 0) return null;
    const row = candidateSchema.parse(rows[0]);
    return { runId: row.run_id, coinsCredited: row.coins_credited, skipped: row.skipped, createdAt: row.created_at, doubleSessionId: row.double_session_id, doubledAt: row.doubled_at };
  }

  async attach(runId: string, accountId: string, sessionId: string): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        UPDATE run_reward SET double_session_id = ${sessionId}
        WHERE run_id = ${runId} AND account_id = ${accountId}::uuid AND (double_session_id IS NULL OR double_session_id = ${sessionId})`) > 0
    );
  }

  async markDoubled(runId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`UPDATE run_reward SET doubled_at = ${at} WHERE run_id = ${runId} AND doubled_at IS NULL`;
  }
}
