import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Самоцветы за ролик (`free_gems_claim`, tasks/T-0243): одна строка на игрока
 * и игровые сутки — «в эти сутки самоцветы уже взяты». Сутки считает база
 * (полночь по Москве), а не код: граница одна у всех реплик.
 */

export interface FreeGemsRow {
  /** игровые сутки взятия, `ГГГГ-ММ-ДД` */
  gameDay: string;
  sessionId: string;
  /** сколько самоцветов записано к начислению */
  gems: number;
}

export interface FreeGemsRecord {
  accountId: string;
  sessionId: string;
  gems: number;
}

/**
 * `granted` — записано; `repeat` — эта же сессия уже записала взятие этих
 * суток (параллельный повтор), начисление дожимается; `taken` — сутки заняты
 * другой сессией или сессия потрачена на другое взятие.
 */
export type RecordOutcome = "granted" | "repeat" | "taken";

export const FREE_GEMS_REPOSITORY = Symbol("FREE_GEMS_REPOSITORY");

export interface FreeGemsRepository {
  /** взятие игровых суток, в которые попадает `at`; `null` — не брали */
  today(accountId: string, at: Date): Promise<FreeGemsRow | null>;
  /** взятие, на которое потрачена сессия показа этого игрока; `null` — сессия свободна */
  bySession(accountId: string, sessionId: string): Promise<FreeGemsRow | null>;
  /** запись взятия суток `at`; проверка и запись неделимы — два параллельных запроса дают одну строку */
  record(input: FreeGemsRecord, at: Date): Promise<RecordOutcome>;
}

const rowSchema = z.object({
  game_day: z.string(),
  session_id: z.string(),
  gems: z.number().int().positive(),
});

function rowOf(raw: unknown): FreeGemsRow {
  const row = rowSchema.parse(raw);
  return { gameDay: row.game_day, sessionId: row.session_id, gems: row.gems };
}

@Injectable()
export class PrismaFreeGemsRepository implements FreeGemsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async today(accountId: string, at: Date): Promise<FreeGemsRow | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT game_day::text, session_id, gems FROM free_gems_claim
      WHERE account_id = ${accountId}::uuid AND game_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`;
    return rows[0] === undefined ? null : rowOf(rows[0]);
  }

  async bySession(accountId: string, sessionId: string): Promise<FreeGemsRow | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT game_day::text, session_id, gems FROM free_gems_claim
      WHERE account_id = ${accountId}::uuid AND session_id = ${sessionId}`;
    return rows[0] === undefined ? null : rowOf(rows[0]);
  }

  async record(input: FreeGemsRecord, at: Date): Promise<RecordOutcome> {
    // Конфликт по ключу суток и по сессии — одно «не записано»; чем занято, смотрим ниже.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO free_gems_claim (account_id, game_day, session_id, gems, created_at)
      VALUES (${input.accountId}::uuid, (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, ${input.sessionId}, ${input.gems}::int, ${at})
      ON CONFLICT DO NOTHING`;
    if (inserted > 0) return "granted";
    return (await this.today(input.accountId, at))?.sessionId === input.sessionId ? "repeat" : "taken";
  }
}
