import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PASS_LANES, claimKey, type PassLane } from "./pass-rules.js";

/**
 * Батл-пасс в базе (tasks/T-0311): очки месяца, ленты из панели, журнал
 * забранных наград и подарки-бусты. Всё — сырой SQL: каждая запись одна
 * атомарная команда или короткая транзакция без внешних вызовов внутри.
 */

/** Интерактивная транзакция: сколько ждать соединения и сколько жить. */
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
/** Очки не растут выше предела `integer` в базе: заведомо недостижимый потолок вместо ошибки переполнения. */
const POINTS_CEILING = 2_000_000_000;

export interface PassClaimInput {
  accountId: string;
  monthKey: string;
  tier: number;
  lane: PassLane;
  /** подарок-буст ступени; `null` — в награде буста нет */
  boost: { id: string; count: number } | null;
  at: Date;
}

export const BATTLE_PASS_REPOSITORY = Symbol("BATTLE_PASS_REPOSITORY");

export interface BattlePassRepository {
  /** Очки игрока в месяце; строки нет — ноль. */
  points(accountId: string, monthKey: string): Promise<number>;
  /**
   * Прибавить очки одной командой `UPDATE … SET points = points + n`: параллельные
   * прибавки не теряются. Возвращает очки до и после — по ним видно, какие ступени взяты.
   */
  addPoints(accountId: string, monthKey: string, points: number, at: Date): Promise<{ before: number; after: number }>;
  /** Лента месяца как лежит в базе (непроверенный `jsonb`); `null` — ленту месяца не заводили. */
  season(monthKey: string): Promise<unknown>;
  /** Забранные награды игрока в месяце: ключи `claimKey`. */
  claimed(accountId: string, monthKey: string): Promise<Set<string>>;
  /**
   * Записать забор и подарок-буст одной транзакцией. `false` — награда уже забрана
   * (параллельный запрос успел раньше): тогда не записано ничего, и подарок второй раз не выдан.
   */
  claim(input: PassClaimInput): Promise<boolean>;
}

const pointsSchema = z.object({ points: z.number().int() });
const seasonSchema = z.object({ tiers: z.unknown() });
const claimSchema = z.object({ tier: z.number().int(), lane: z.enum(PASS_LANES) });

@Injectable()
export class PrismaBattlePassRepository implements BattlePassRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async points(accountId: string, monthKey: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<unknown[]>`SELECT points FROM pass_progress WHERE account_id = ${accountId}::uuid AND month_key = ${monthKey}`;
    return row === undefined ? 0 : pointsSchema.parse(row).points;
  }

  async addPoints(accountId: string, monthKey: string, points: number, at: Date): Promise<{ before: number; after: number }> {
    const [row] = await this.prisma.$queryRaw<unknown[]>`
      INSERT INTO pass_progress (account_id, month_key, points, updated_at)
      VALUES (${accountId}::uuid, ${monthKey}, ${points}, ${at})
      ON CONFLICT (account_id, month_key) DO UPDATE
        SET points = LEAST(pass_progress.points + EXCLUDED.points, ${POINTS_CEILING}), updated_at = EXCLUDED.updated_at
      RETURNING points`;
    const after = pointsSchema.parse(row).points;
    return { before: Math.max(0, after - points), after };
  }

  async season(monthKey: string): Promise<unknown> {
    const [row] = await this.prisma.$queryRaw<unknown[]>`SELECT tiers FROM pass_season WHERE month_key = ${monthKey}`;
    return row === undefined ? null : seasonSchema.parse(row).tiers;
  }

  async claimed(accountId: string, monthKey: string): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT tier::int AS tier, lane FROM pass_claim WHERE account_id = ${accountId}::uuid AND month_key = ${monthKey}`;
    return new Set(rows.map((raw) => claimSchema.parse(raw)).map((row) => claimKey(row.tier, row.lane)));
  }

  async claim(input: PassClaimInput): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      // Первым — журнал: ключ уникален, и параллельный запрос ждёт на нём того, кто его занял,
      // а после его фиксации расходится на конфликте, ничего не выдав.
      const inserted = await tx.$executeRaw`
        INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at)
        VALUES (${input.accountId}::uuid, ${input.monthKey}, ${input.tier}, ${input.lane}, ${input.at})
        ON CONFLICT DO NOTHING`;
      if (inserted === 0) return false;
      if (input.boost !== null) {
        await tx.$executeRaw`
          INSERT INTO boost_credit (account_id, boost_id, count)
          VALUES (${input.accountId}::uuid, ${input.boost.id}, ${input.boost.count})
          ON CONFLICT (account_id, boost_id) DO UPDATE SET count = boost_credit.count + EXCLUDED.count`;
      }
      return true;
    }, TX_OPTIONS);
  }
}
