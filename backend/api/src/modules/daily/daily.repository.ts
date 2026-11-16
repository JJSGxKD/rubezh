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
  /** ступень серии после последнего забора (T-0262); ноль — забора не было */
  streak: number;
  /** игровые сутки последнего забора, `ГГГГ-ММ-ДД`; `null` — забора не было */
  lastClaimDay: string | null;
  /** сегодняшние игровые сутки по часам базы, `ГГГГ-ММ-ДД` */
  today: string;
}

export const DAILY_REPOSITORY = Symbol("DAILY_REPOSITORY");

export interface DailyRepository {
  state(accountId: string, at: Date): Promise<DailyState>;
  /**
   * Отметить забор дня: только если забрано ровно `expected` дней и не в эти
   * сутки. `false` — опередил параллельный запрос или сутки уже закрыты.
   * `streak` — новая ступень серии, пишется той же строкой (T-0262).
   */
  advance(accountId: string, expected: number, at: Date, streak: number): Promise<boolean>;
}

const stateSchema = z.object({
  claimed_days: z.number().int().nonnegative().nullable(),
  claimed_today: z.boolean().nullable(),
  streak: z.number().int().min(0).max(10).nullable(),
  last_claim_day: z.string().nullable(),
  today: z.string(),
});

@Injectable()
export class PrismaDailyRepository implements DailyRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async state(accountId: string, at: Date): Promise<DailyState> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT d.claimed_days, d.last_claim_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date AS claimed_today,
        d.streak::int AS streak, d.last_claim_day::text AS last_claim_day, (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date::text AS today
      FROM (SELECT 1) AS one LEFT JOIN daily_reward d ON d.account_id = ${accountId}::uuid`;
    const row = stateSchema.parse(rows[0]);
    return { claimedDays: row.claimed_days ?? 0, claimedToday: row.claimed_today ?? false, streak: row.streak ?? 0, lastClaimDay: row.last_claim_day, today: row.today };
  }

  async advance(accountId: string, expected: number, at: Date, streak: number): Promise<boolean> {
    // Строка появляется с первым забранным днём, поэтому «ноль» — это «строки
    // нет»: второй параллельный первый забор упрётся в ключ.
    if (expected === 0) {
      return (
        (await this.prisma.$executeRaw`
          INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, streak, updated_at)
          VALUES (${accountId}::uuid, 1, (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, ${streak}::smallint, ${at})
          ON CONFLICT (account_id) DO NOTHING`) > 0
      );
    }
    return (
      (await this.prisma.$executeRaw`
        UPDATE daily_reward
        SET claimed_days = claimed_days + 1, last_claim_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, streak = ${streak}::smallint, updated_at = ${at}
        WHERE account_id = ${accountId}::uuid AND claimed_days = ${expected}::int
          AND last_claim_day < (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`) > 0
    );
  }
}

/**
 * Удвоение награды дня за ролик (`daily_double`, tasks/T-0242): одна строка на
 * игрока и игровые сутки. В `daily_reward` строка одна на игрока, поэтому
 * «удвоено сегодня» хранится отдельно.
 */

export interface DailyDoubleRow {
  /** игровые сутки удвоения, `ГГГГ-ММ-ДД` */
  gameDay: string;
  /** номер удвоенного дня по порядку забора */
  dayNumber: number;
  sessionId: string;
  coins: number;
  shards: number;
}

export interface DailyDoubleRecord {
  accountId: string;
  sessionId: string;
  dayNumber: number;
  coins: number;
  shards: number;
}

/**
 * `granted` — записано; `repeat` — эта же сессия уже записала удвоение этих
 * суток (параллельный повтор), начисление дожимается; `taken` — сутки заняты
 * другой сессией или сессия потрачена на другое удвоение.
 */
export type RecordOutcome = "granted" | "repeat" | "taken";

export const DAILY_DOUBLE_REPOSITORY = Symbol("DAILY_DOUBLE_REPOSITORY");

export interface DailyDoubleRepository {
  /** удвоение игровых суток, в которые попадает `at`; `null` — не удваивали */
  today(accountId: string, at: Date): Promise<DailyDoubleRow | null>;
  /** удвоение, на которое потрачена сессия показа этого игрока; `null` — сессия свободна */
  bySession(accountId: string, sessionId: string): Promise<DailyDoubleRow | null>;
  /** запись удвоения суток `at`; проверка и запись неделимы — два параллельных запроса дают одну строку */
  record(input: DailyDoubleRecord, at: Date): Promise<RecordOutcome>;
}

const doubleSchema = z.object({
  game_day: z.string(),
  day_number: z.number().int(),
  session_id: z.string(),
  coins: z.number().int().nonnegative(),
  shards: z.number().int().nonnegative(),
});

function doubleRowOf(raw: unknown): DailyDoubleRow {
  const row = doubleSchema.parse(raw);
  return { gameDay: row.game_day, dayNumber: row.day_number, sessionId: row.session_id, coins: row.coins, shards: row.shards };
}

@Injectable()
export class PrismaDailyDoubleRepository implements DailyDoubleRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async today(accountId: string, at: Date): Promise<DailyDoubleRow | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT game_day::text, day_number, session_id, coins, shards FROM daily_double
      WHERE account_id = ${accountId}::uuid AND game_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`;
    return rows[0] === undefined ? null : doubleRowOf(rows[0]);
  }

  async bySession(accountId: string, sessionId: string): Promise<DailyDoubleRow | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT game_day::text, day_number, session_id, coins, shards FROM daily_double
      WHERE account_id = ${accountId}::uuid AND session_id = ${sessionId}`;
    return rows[0] === undefined ? null : doubleRowOf(rows[0]);
  }

  async record(input: DailyDoubleRecord, at: Date): Promise<RecordOutcome> {
    // Конфликт по ключу суток и по сессии — одно «не записано»; чем занято, смотрим ниже.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO daily_double (account_id, game_day, day_number, session_id, coins, shards, created_at)
      VALUES (${input.accountId}::uuid, (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, ${input.dayNumber}::int, ${input.sessionId}, ${input.coins}::int, ${input.shards}::int, ${at})
      ON CONFLICT DO NOTHING`;
    if (inserted > 0) return "granted";
    return (await this.today(input.accountId, at))?.sessionId === input.sessionId ? "repeat" : "taken";
  }
}
