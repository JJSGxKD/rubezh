import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Награда дня в базе (`daily_reward`). Игровые сутки считает база — одна
 * граница у всех реплик (`common/game-day.ts`).
 */

export interface DailyState {
  claimedDays: number;
  /** забрано ли в эти игровые сутки */
  claimedToday: boolean;
}

export const DAILY_REPOSITORY = Symbol("DAILY_REPOSITORY");

export interface DailyRepository {
  state(accountId: string, at: Date): Promise<DailyState>;
  /**
   * Отметить забор дня: только если забрано ровно `expected` дней и не в эти
   * сутки. `false` — опередил параллельный запрос или сутки уже закрыты.
   */
  advance(accountId: string, expected: number, at: Date): Promise<boolean>;
}

const stateSchema = z.object({ claimed_days: z.number().int().nonnegative().nullable(), claimed_today: z.boolean().nullable() });

@Injectable()
export class PrismaDailyRepository implements DailyRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async state(accountId: string, at: Date): Promise<DailyState> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT d.claimed_days, d.last_claim_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date AS claimed_today
      FROM (SELECT 1) AS one LEFT JOIN daily_reward d ON d.account_id = ${accountId}::uuid`;
    const row = stateSchema.parse(rows[0]);
    return { claimedDays: row.claimed_days ?? 0, claimedToday: row.claimed_today ?? false };
  }

  async advance(accountId: string, expected: number, at: Date): Promise<boolean> {
    // Строка появляется с первым забранным днём, поэтому «ноль» — это «строки
    // нет»: второй параллельный первый забор упрётся в ключ.
    if (expected === 0) {
      return (
        (await this.prisma.$executeRaw`
          INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, updated_at)
          VALUES (${accountId}::uuid, 1, (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, ${at})
          ON CONFLICT (account_id) DO NOTHING`) > 0
      );
    }
    return (
      (await this.prisma.$executeRaw`
        UPDATE daily_reward
        SET claimed_days = claimed_days + 1, last_claim_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, updated_at = ${at}
        WHERE account_id = ${accountId}::uuid AND claimed_days = ${expected}::int
          AND last_claim_day < (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`) > 0
    );
  }
}
