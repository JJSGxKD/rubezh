import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { BOT_MENTION_KINDS, BOT_MENTION_RESULTS, type BotMentionKind, type BotMentionResult, type BotMentionRow } from "./bot-mention-rules.js";

/**
 * Состояние заданий «юзернейм бота» в базе (`bot_mention_task`,
 * tasks/T-0162). Запросы сырые: серию и награду суток держит один `UPDATE`
 * с условием, и в его тексте должно быть видно, что именно он гарантирует.
 * Игровые сутки приходят строкой `YYYY-MM-DD` — их считает прикладной код
 * (`gameDayOf`), база только сравнивает даты.
 */

export const BOT_MENTION_REPOSITORY = Symbol("BOT_MENTION_REPOSITORY");

/** Аккаунт, которого пора проверять, и виды, по которым это нужно сделать. */
export interface DueAccount {
  accountId: string;
  platformUserId: string;
  /** в порядке `BOT_MENTION_KINDS` */
  kinds: BotMentionKind[];
}

export interface BotMentionRepository {
  /** Начать задание: строки нет — заводится, есть — остаётся как была. */
  ensure(accountId: string, kind: BotMentionKind, at: Date): Promise<void>;
  rows(accountId: string): Promise<BotMentionRow[]>;
  /**
   * Исход без награды. Награждённые сутки отметкой «убрал» не перекрываются,
   * а отметка не идёт назад по суткам.
   */
  markChecked(accountId: string, kind: BotMentionKind, day: string, result: Exclude<BotMentionResult, "present">, at: Date): Promise<void>;
  /**
   * Засчитать сутки: серия, лучшая серия, число суток и отметка проверки — одним
   * `UPDATE`. Строка — если сутки засчитал этот вызов, `null` — они уже
   * засчитаны (или засчитаны более поздние): две одновременные проверки дают
   * один рост серии.
   */
  rewardDay(accountId: string, kind: BotMentionKind, day: string, at: Date): Promise<BotMentionRow | null>;
  /**
   * Кого пора проверять в сутках `day`: аккаунты площадки с начатым заданием
   * из `kinds`, не проверенным в эти сутки. Сначала никогда не проверенные и
   * самые давние, потом по времени начала.
   */
  due(platform: PlatformId, day: string, kinds: readonly BotMentionKind[], limit: number): Promise<DueAccount[]>;
}

const rowSchema = z.object({
  account_id: z.string(),
  kind: z.enum(BOT_MENTION_KINDS),
  started_at: z.date(),
  streak: z.number().int(),
  best_streak: z.number().int(),
  rewarded_days: z.number().int(),
  last_day: z.string().nullable(),
  checked_day: z.string().nullable(),
  checked_at: z.date().nullable(),
  last_result: z.enum(BOT_MENTION_RESULTS).nullable(),
});

const dueSchema = z.object({ account_id: z.string(), platform_user_id: z.string(), kinds: z.string() });

/** Столбцы строки состояния; даты суток — строкой, чтобы пояс процесса не сдвигал число. */
const COLUMNS = Prisma.sql`account_id::text AS account_id, kind, started_at, streak, best_streak, rewarded_days,
  to_char(last_day, 'YYYY-MM-DD') AS last_day, to_char(checked_day, 'YYYY-MM-DD') AS checked_day, checked_at, last_result`;

function toRow(raw: unknown): BotMentionRow {
  const row = rowSchema.parse(raw);
  return {
    accountId: row.account_id,
    kind: row.kind,
    startedAt: row.started_at,
    streak: row.streak,
    bestStreak: row.best_streak,
    rewardedDays: row.rewarded_days,
    lastDay: row.last_day,
    checkedDay: row.checked_day,
    checkedAt: row.checked_at,
    lastResult: row.last_result,
  };
}

@Injectable()
export class PrismaBotMentionRepository implements BotMentionRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async ensure(accountId: string, kind: BotMentionKind, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO bot_mention_task (account_id, kind, started_at)
      VALUES (${accountId}::uuid, ${kind}, ${at})
      ON CONFLICT (account_id, kind) DO NOTHING`;
  }

  async rows(accountId: string): Promise<BotMentionRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT ${COLUMNS} FROM bot_mention_task WHERE account_id = ${accountId}::uuid ORDER BY started_at, kind`;
    return rows.map(toRow);
  }

  async markChecked(accountId: string, kind: BotMentionKind, day: string, result: Exclude<BotMentionResult, "present">, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE bot_mention_task SET checked_day = ${day}::date, checked_at = ${at}, last_result = ${result}
      WHERE account_id = ${accountId}::uuid AND kind = ${kind}
        AND last_day IS DISTINCT FROM ${day}::date
        AND (checked_day IS NULL OR checked_day <= ${day}::date)`;
  }

  async rewardDay(accountId: string, kind: BotMentionKind, day: string, at: Date): Promise<BotMentionRow | null> {
    // Серия продолжается, если прошлая награда — за вчера; иначе начинается заново.
    // Условие `last_day < day` не пускает повтор тех же суток и награду задним числом.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      UPDATE bot_mention_task SET
        streak = CASE WHEN last_day = ${day}::date - 1 THEN streak + 1 ELSE 1 END,
        best_streak = GREATEST(best_streak, CASE WHEN last_day = ${day}::date - 1 THEN streak + 1 ELSE 1 END),
        rewarded_days = rewarded_days + 1,
        last_day = ${day}::date, checked_day = ${day}::date, checked_at = ${at}, last_result = 'present'
      WHERE account_id = ${accountId}::uuid AND kind = ${kind}
        AND (last_day IS NULL OR last_day < ${day}::date)
      RETURNING ${COLUMNS}`;
    const row = rows[0];
    return row === undefined ? null : toRow(row);
  }

  async due(platform: PlatformId, day: string, kinds: readonly BotMentionKind[], limit: number): Promise<DueAccount[]> {
    if (kinds.length === 0 || limit <= 0) return [];
    // Заблокированных не проверяем (как и рассылки): их награда никому не нужна, а квота площадки — общая.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT t.account_id::text AS account_id, a.platform_user_id, string_agg(t.kind, ',') AS kinds
      FROM bot_mention_task t
      JOIN account a ON a.account_id = t.account_id
      WHERE a.platform = ${platform}::"Platform" AND a.banned_at IS NULL
        AND t.kind = ANY(${[...kinds]}::text[])
        AND t.checked_day IS DISTINCT FROM ${day}::date
      GROUP BY t.account_id, a.platform_user_id
      ORDER BY MIN(COALESCE(t.checked_day, DATE '0001-01-01')), MIN(t.started_at), t.account_id
      LIMIT ${limit}`;
    return rows.map((raw) => {
      const row = dueSchema.parse(raw);
      const found = new Set(row.kinds.split(","));
      return { accountId: row.account_id, platformUserId: row.platform_user_id, kinds: BOT_MENTION_KINDS.filter((kind) => found.has(kind)) };
    });
  }
}
