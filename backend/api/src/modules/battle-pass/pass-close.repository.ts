import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { claimKey, PASS_LANES } from "./pass-rules.js";

/**
 * Закрытие месяца пасса в базе (tasks/T-0312): кого обходить, что из этого уже
 * забрано, сколько наград выдало само закрытие и метка «месяц закрыт». Всё —
 * чтение пачками и одна короткая вставка; сама выдача идёт тем же путём, что
 * ручной забор (`battle-pass.repository.ts`), поэтому здесь её нет.
 */

export const PASS_CLOSE_REPOSITORY = Symbol("PASS_CLOSE_REPOSITORY");

/** Игрок месяца и его очки. */
export interface PassPlayer {
  accountId: string;
  points: number;
}

export interface PassCloseRepository {
  /** Какие из месяцев уже закрыты. */
  closedMonths(monthKeys: readonly string[]): Promise<Set<string>>;
  /**
   * Следующая пачка игроков месяца с очками не меньше `minPoints` — тех, у кого
   * есть хоть одна ступень. Постранично по ключу `after`: месяц на миллион игроков
   * не ложится в память целиком.
   */
  players(monthKey: string, minPoints: number, after: string, limit: number): Promise<PassPlayer[]>;
  /** Забранные награды игроков в месяце: ключи `claimKey` по аккаунту. */
  claimed(monthKey: string, accountIds: readonly string[]): Promise<Map<string, Set<string>>>;
  /**
   * Сколько наград выдало закрытие: забранные не раньше `since` — конца месяца.
   * Ручной забор месяца кончается вместе с ним, поэтому всё, что записано позже,
   * принадлежит закрытию. Число одно и то же при любом повторе и на любой реплике.
   */
  closeRewards(monthKey: string, accountIds: readonly string[], since: Date): Promise<Map<string, number>>;
  /** Поставить метку «месяц закрыт». `false` — метка уже стояла: закрыл другой. */
  markClosed(monthKey: string, at: Date): Promise<boolean>;
}

const playerSchema = z.object({ account_id: z.uuid(), points: z.number().int() });
const claimedSchema = z.object({ account_id: z.uuid(), tier: z.number().int(), lane: z.enum(PASS_LANES) });
const rewardsSchema = z.object({ account_id: z.uuid(), rewards: z.number().int() });
const monthSchema = z.object({ month_key: z.string() });

@Injectable()
export class PrismaPassCloseRepository implements PassCloseRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async closedMonths(monthKeys: readonly string[]): Promise<Set<string>> {
    if (monthKeys.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT month_key FROM pass_close WHERE month_key = ANY(${[...monthKeys]}::text[])`;
    return new Set(rows.map((raw) => monthSchema.parse(raw).month_key));
  }

  async players(monthKey: string, minPoints: number, after: string, limit: number): Promise<PassPlayer[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, points FROM pass_progress
      WHERE month_key = ${monthKey} AND points >= ${minPoints} AND account_id > ${after}::uuid
      ORDER BY account_id
      LIMIT ${limit}`;
    return rows.map((raw) => {
      const row = playerSchema.parse(raw);
      return { accountId: row.account_id, points: row.points };
    });
  }

  async claimed(monthKey: string, accountIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (accountIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, tier::int AS tier, lane FROM pass_claim
      WHERE month_key = ${monthKey} AND account_id = ANY(${[...accountIds]}::uuid[])`;
    for (const raw of rows) {
      const row = claimedSchema.parse(raw);
      const keys = result.get(row.account_id) ?? new Set<string>();
      keys.add(claimKey(row.tier, row.lane));
      result.set(row.account_id, keys);
    }
    return result;
  }

  async closeRewards(monthKey: string, accountIds: readonly string[], since: Date): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (accountIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, count(*)::int AS rewards FROM pass_claim
      WHERE month_key = ${monthKey} AND account_id = ANY(${[...accountIds]}::uuid[]) AND claimed_at >= ${since}
      GROUP BY account_id`;
    for (const raw of rows) {
      const row = rewardsSchema.parse(raw);
      result.set(row.account_id, row.rewards);
    }
    return result;
  }

  async markClosed(monthKey: string, at: Date): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`INSERT INTO pass_close (month_key, closed_at) VALUES (${monthKey}, ${at}) ON CONFLICT (month_key) DO NOTHING`;
    return inserted > 0;
  }
}
