import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { RATED_DIFFICULTIES } from "../runs/run-rules.js";
import { REMINDER_KINDS, type ReminderKind } from "./reminder-rules.js";

/**
 * Запросы напоминаний к Postgres (tasks/T-0128). Кандидатов читают страницами
 * с курсором по `account_id`: проход берёт `TICK_LIMIT` строк за раз, и сотни
 * тысяч игроков не ложатся в память. В каждую выборку входят только те, кому
 * можно писать: нет бана и `account_messaging.can_message` — игрок без
 * разрешения не получает даже строки в ленте.
 *
 * Игровые сутки приходят строкой `YYYY-MM-DD` — день, по которому планировщик
 * строит и ключ события; так база и код не могут разойтись на границе суток.
 */

export interface ReminderTarget {
  accountId: string;
  platform: PlatformId;
}

/** Итог игровых суток для отчёта команде. */
export interface DaySummary {
  /** сколько напоминаний каждого вида доставлено ботом */
  sent: Record<ReminderKind, number>;
  /** не дошло: площадка отказала или игрок уже заблокировал бота */
  undelivered: number;
  /** игроки, заблокировавшие бота после напоминания, которое им дошло */
  blockedAfter: number;
}

export const REMINDERS_REPOSITORY = Symbol("REMINDERS_REPOSITORY");

export interface RemindersRepository {
  /** Кому из аккаунтов можно писать: без бана и с разрешением. Остальных в ответе нет. */
  reachable(accountIds: readonly string[]): Promise<ReminderTarget[]>;
  /** Игроки с рейтинговым забегом, законченным в окне недели, после курсора. */
  closingPage(window: { from: Date; to: Date }, after: string | null, limit: number): Promise<ReminderTarget[]>;
  /**
   * Игроки, не забравшие награду дня сегодня и забиравшие её не позже
   * `lapseDays` суток назад, после курсора. Строки награды нет у тех, кто не
   * забирал её никогда, — им напоминать не о чем. Аккаунт без `prologue_done_at`
   * не зовём: «Награда дня» закрыта, пока не пройден пролог (Р151), и
   * напоминание привело бы к 409.
   */
  dailyPage(query: { today: string; lapseDays: number }, after: string | null, limit: number): Promise<ReminderTarget[]>;
  /** Цифры суток по ленте уведомлений и состоянию «можно ли писать». */
  daySummary(window: { from: Date; to: Date }): Promise<DaySummary>;
}

const targetRows = z.array(z.object({ account_id: z.string(), platform: z.enum(PLATFORM_IDS) }));

const summaryRows = z.array(z.object({ kind: z.string(), sent: z.coerce.number(), undelivered: z.coerce.number(), blocked_after: z.coerce.number() }));

/** Нулевой UUID: меньше любого настоящего, поэтому «после него» — это с начала. */
const FROM_START = "00000000-0000-0000-0000-000000000000";

@Injectable()
export class PrismaRemindersRepository implements RemindersRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async reachable(accountIds: readonly string[]): Promise<ReminderTarget[]> {
    if (accountIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT a.account_id, a.platform
      FROM account a
      JOIN account_messaging m ON m.account_id = a.account_id AND m.can_message
      WHERE a.account_id = ANY(${[...accountIds]}::uuid[]) AND a.banned_at IS NULL`;
    return toTargets(rows);
  }

  async closingPage(window: { from: Date; to: Date }, after: string | null, limit: number): Promise<ReminderTarget[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT a.account_id, a.platform
      FROM account a
      JOIN account_messaging m ON m.account_id = a.account_id AND m.can_message
      WHERE a.account_id > ${after ?? FROM_START}::uuid AND a.banned_at IS NULL
        AND EXISTS (
          SELECT 1 FROM run r
          WHERE r.account_id = a.account_id AND r.status = 'finished' AND r.ranked
            AND r.difficulty::text = ANY(${[...RATED_DIFFICULTIES]}::text[])
            AND r.finished_at >= ${window.from} AND r.finished_at < ${window.to}
        )
      ORDER BY a.account_id
      LIMIT ${limit}`;
    return toTargets(rows);
  }

  async dailyPage(query: { today: string; lapseDays: number }, after: string | null, limit: number): Promise<ReminderTarget[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT d.account_id, a.platform
      FROM daily_reward d
      JOIN account a ON a.account_id = d.account_id AND a.banned_at IS NULL AND a.prologue_done_at IS NOT NULL
      JOIN account_messaging m ON m.account_id = d.account_id AND m.can_message
      WHERE d.account_id > ${after ?? FROM_START}::uuid
        AND d.last_claim_day < ${query.today}::date
        AND d.last_claim_day >= ${query.today}::date - ${query.lapseDays}::int
      ORDER BY d.account_id
      LIMIT ${limit}`;
    return toTargets(rows);
  }

  async daySummary(window: { from: Date; to: Date }): Promise<DaySummary> {
    // «Заблокировали после»: аккаунт, которому напоминание дошло, а потом площадка
    // сообщила о блокировке — отметка новее отправки. Считаются аккаунты, не строки.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT n.kind,
        count(*) FILTER (WHERE n.bot_outcome = 'sent') AS sent,
        count(*) FILTER (WHERE n.bot_outcome IN ('failed', 'blocked')) AS undelivered,
        count(DISTINCT n.account_id) FILTER (WHERE n.bot_outcome = 'sent' AND m.can_message = false AND m.reason = 'blocked' AND m.changed_at >= n.bot_at) AS blocked_after
      FROM notification n
      LEFT JOIN account_messaging m ON m.account_id = n.account_id
      WHERE n.kind = ANY(${[...REMINDER_KINDS]}::text[]) AND n.created_at >= ${window.from} AND n.created_at < ${window.to}
      GROUP BY n.kind`;
    const sent: Record<ReminderKind, number> = { season_overtaken: 0, season_closing: 0, daily_reward_ready: 0 };
    let undelivered = 0;
    let blockedAfter = 0;
    for (const row of summaryRows.parse(rows)) {
      const kind = REMINDER_KINDS.find((candidate) => candidate === row.kind);
      if (kind === undefined) continue;
      sent[kind] = row.sent;
      undelivered += row.undelivered;
      blockedAfter += row.blocked_after;
    }
    return { sent, undelivered, blockedAfter };
  }
}

function toTargets(rows: unknown[]): ReminderTarget[] {
  return targetRows.parse(rows).map((row) => ({ accountId: row.account_id, platform: row.platform }));
}
