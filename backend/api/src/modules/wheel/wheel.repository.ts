import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { WheelReward } from "./wheel-rules.js";

/**
 * Крутки колеса в базе (`wheel_spin`). Игровые сутки считает база — одна
 * граница у всех реплик (`common/game-day.ts`). Бесплатная крутка суток одна:
 * её держит частичный уникальный индекс, а не проверка перед вставкой; крутка
 * за рекламу одна на сессию показа — уникальный индекс по сессии.
 */

export interface WheelSpinRow {
  spinId: string;
  sector: number;
  resource: WheelReward["resource"];
  amount: number;
  /** кошелёк начислил — крутка закрыта */
  granted: boolean;
}

export interface NewWheelSpin extends WheelReward {
  sector: number;
}

export const WHEEL_REPOSITORY = Symbol("WHEEL_REPOSITORY");

export interface WheelRepository {
  /** бесплатная крутка этих игровых суток, если была */
  freeToday(accountId: string, at: Date): Promise<WheelSpinRow | null>;
  /** записать бесплатную крутку суток; `null` — в эти сутки её уже записали */
  insertFree(accountId: string, spin: NewWheelSpin, at: Date): Promise<WheelSpinRow | null>;
  /** записать крутку за рекламу; `null` — по этой сессии показа уже крутили */
  insertAd(accountId: string, adSessionId: string, spin: NewWheelSpin, at: Date): Promise<WheelSpinRow | null>;
  /** крутка по сессии показа, если была */
  byAdSession(accountId: string, adSessionId: string): Promise<WheelSpinRow | null>;
  markGranted(spinId: string, at: Date): Promise<void>;
}

const rowSchema = z.object({
  spin_id: z.string(),
  sector: z.number().int().nonnegative(),
  resource: z.enum(["coins", "shard_common", "shard_uncommon"]),
  amount: z.number().int().positive(),
  granted: z.boolean(),
});

@Injectable()
export class PrismaWheelRepository implements WheelRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async freeToday(accountId: string, at: Date): Promise<WheelSpinRow | null> {
    // `source = 'free'` — литералом, а не параметром: иначе планировщик не
    // докажет условие частичного индекса и пойдёт мимо него.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT spin_id::text, sector, resource::text, amount, granted_at IS NOT NULL AS granted
      FROM wheel_spin
      WHERE account_id = ${accountId}::uuid AND source = 'free'
        AND game_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`;
    if (rows.length === 0) return null;
    const row = rowSchema.parse(rows[0]);
    return { spinId: row.spin_id, sector: row.sector, resource: row.resource, amount: row.amount, granted: row.granted };
  }

  async insertFree(accountId: string, spin: NewWheelSpin, at: Date): Promise<WheelSpinRow | null> {
    const spinId = randomUUID();
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO wheel_spin (spin_id, account_id, source, game_day, sector, resource, amount, created_at)
      VALUES (${spinId}::uuid, ${accountId}::uuid, 'free', (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date,
              ${spin.sector}::smallint, ${spin.resource}::"WalletResource", ${spin.amount}::int, ${at})
      ON CONFLICT (account_id, game_day) WHERE source = 'free' DO NOTHING`;
    return inserted > 0 ? { spinId, sector: spin.sector, resource: spin.resource, amount: spin.amount, granted: false } : null;
  }

  async insertAd(accountId: string, adSessionId: string, spin: NewWheelSpin, at: Date): Promise<WheelSpinRow | null> {
    const spinId = randomUUID();
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO wheel_spin (spin_id, account_id, source, game_day, sector, resource, amount, created_at, ad_session_id)
      VALUES (${spinId}::uuid, ${accountId}::uuid, 'ad', (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date,
              ${spin.sector}::smallint, ${spin.resource}::"WalletResource", ${spin.amount}::int, ${at}, ${adSessionId})
      ON CONFLICT (ad_session_id) DO NOTHING`;
    return inserted > 0 ? { spinId, sector: spin.sector, resource: spin.resource, amount: spin.amount, granted: false } : null;
  }

  async byAdSession(accountId: string, adSessionId: string): Promise<WheelSpinRow | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT spin_id::text, sector, resource::text, amount, granted_at IS NOT NULL AS granted
      FROM wheel_spin WHERE ad_session_id = ${adSessionId} AND account_id = ${accountId}::uuid`;
    if (rows.length === 0) return null;
    const row = rowSchema.parse(rows[0]);
    return { spinId: row.spin_id, sector: row.sector, resource: row.resource, amount: row.amount, granted: row.granted };
  }

  async markGranted(spinId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`UPDATE wheel_spin SET granted_at = ${at} WHERE spin_id = ${spinId}::uuid AND granted_at IS NULL`;
  }
}
