import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Второй шанс за рекламу в базе (docs/35-stage4-plan.md WP11, Р4):
 * продолжение забега по сессии показа. Номер продолжения и сессия —
 * уникальны, поэтому одно продолжение не выдаётся дважды, а одна сессия не
 * продолжает два забега.
 */

export interface AdContinueGrant {
  runId: string;
  continueNo: number;
  accountId: string;
  sessionId: string;
  networkKey: string;
  grantedAt: Date;
}

/**
 * `granted` — записано; `repeat` — та же сессия уже продолжила этот забег
 * под этим номером, ответ дожимается; `taken` — номер занят другой сессией
 * или сессия уже потрачена на другое продолжение.
 */
export type GrantOutcome = "granted" | "repeat" | "taken";

export const RUN_AD_CONTINUES_REPOSITORY = Symbol("RUN_AD_CONTINUES_REPOSITORY");

export interface RunAdContinuesRepository {
  grant(grant: AdContinueGrant): Promise<GrantOutcome>;
  /** продолжение, на которое уже потрачена сессия; `null` — сессия свободна */
  bySession(sessionId: string): Promise<{ runId: string; continueNo: number } | null>;
  /** номера продолжений забега, выданных за рекламу */
  numbers(runId: string): Promise<number[]>;
  /** сколько рекламных продолжений у игрока с начала игровых суток, в которые попадает `at` */
  todayCount(accountId: string, at: Date): Promise<number>;
}

const grantedSchema = z.object({ run_id: z.string(), continue_no: z.number().int(), session_id: z.string() });

@Injectable()
export class PrismaRunAdContinuesRepository implements RunAdContinuesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async grant(grant: AdContinueGrant): Promise<GrantOutcome> {
    // Конфликт по любому ключу — номер или сессия заняты: дальше смотрим, чем.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO run_ad_continue (run_id, continue_no, account_id, session_id, network_key, granted_at)
      VALUES (${grant.runId}, ${grant.continueNo}, ${grant.accountId}::uuid, ${grant.sessionId}, ${grant.networkKey}, ${grant.grantedAt})
      ON CONFLICT DO NOTHING`;
    if (inserted > 0) return "granted";
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT run_id, continue_no, session_id FROM run_ad_continue
      WHERE session_id = ${grant.sessionId} OR (run_id = ${grant.runId} AND continue_no = ${grant.continueNo})`;
    const existing = rows.map((row) => grantedSchema.parse(row));
    const same = existing.some((row) => row.session_id === grant.sessionId && row.run_id === grant.runId && row.continue_no === grant.continueNo);
    return same ? "repeat" : "taken";
  }

  async bySession(sessionId: string): Promise<{ runId: string; continueNo: number } | null> {
    return await this.prisma.runAdContinue.findUnique({ where: { sessionId }, select: { runId: true, continueNo: true } });
  }

  async numbers(runId: string): Promise<number[]> {
    const rows = await this.prisma.runAdContinue.findMany({ where: { runId }, select: { continueNo: true }, orderBy: { continueNo: "asc" } });
    return rows.map((row) => row.continueNo);
  }

  async todayCount(accountId: string, at: Date): Promise<number> {
    // Начало суток считает база — граница одна у всех суточных механик (common/game-day.ts).
    const rows = await this.prisma.$queryRaw<{ count: unknown }[]>`
      WITH day AS (SELECT (date_trunc('day', ${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE}) AT TIME ZONE ${GAME_DAY_TIME_ZONE}) AS start)
      SELECT count(*)::int AS count FROM run_ad_continue, day
      WHERE account_id = ${accountId}::uuid AND granted_at >= day.start AND granted_at < day.start + interval '1 day'`;
    return z.number().int().parse(rows[0]?.count ?? 0);
  }
}
