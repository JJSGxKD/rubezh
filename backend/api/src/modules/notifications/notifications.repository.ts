import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/** Уведомления в базе (`notification`): запись без дублей, лента по курсору, прочитанное. */

export interface StoredNotification {
  notificationId: string;
  kind: string;
  /** JSON как есть — разбирает схема вида */
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
}

export interface NewNotification {
  accountId: string;
  kind: string;
  payload: unknown;
  dedupeKey: string;
  at: Date;
}

/** Где остановилась лента: время и id последней отданной строки — строки одного мгновения не теряются. */
export interface FeedCursor {
  createdAt: Date;
  notificationId: string;
}

export const NOTIFICATIONS_REPOSITORY = Symbol("NOTIFICATIONS_REPOSITORY");

/** Чем кончился дубль уведомления в бота — перечисление `NotificationBotOutcome` в схеме. */
export type BotOutcome = "sent" | "blocked" | "failed";

export interface NotificationsRepository {
  /** id записанного; `null` — событие уже записано: повтор ничего не добавляет */
  insert(notification: NewNotification): Promise<string | null>;
  /** исход дубля в бота — один раз: повтор задания очереди прежний исход не перепишет */
  markBot(notificationId: string, outcome: BotOutcome, at: Date): Promise<void>;
  feed(accountId: string, cursor: FeedCursor | null, limit: number): Promise<StoredNotification[]>;
  unread(accountId: string): Promise<number>;
  /** прочитать всё не новее `upTo`; `null` — всё */
  markRead(accountId: string, upTo: Date | null, at: Date): Promise<void>;
  createdAtOf(accountId: string, notificationId: string): Promise<Date | null>;
  /** удалить не больше `limit` строк старше `before`; сколько удалено */
  purge(before: Date, limit: number): Promise<number>;
}

const rowSchema = z.object({
  notification_id: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  created_at: z.date(),
  read_at: z.date().nullable(),
});

@Injectable()
export class PrismaNotificationsRepository implements NotificationsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insert(notification: NewNotification): Promise<string | null> {
    const payload = JSON.stringify(notification.payload);
    const notificationId = randomUUID();
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO notification (notification_id, account_id, kind, payload, dedupe_key, created_at)
      VALUES (${notificationId}::uuid, ${notification.accountId}::uuid, ${notification.kind}, ${payload}::jsonb, ${notification.dedupeKey}, ${notification.at})
      ON CONFLICT (account_id, dedupe_key) DO NOTHING`;
    return inserted > 0 ? notificationId : null;
  }

  async markBot(notificationId: string, outcome: BotOutcome, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notification SET bot_outcome = ${outcome}::"NotificationBotOutcome", bot_at = ${at}
      WHERE notification_id = ${notificationId}::uuid AND bot_outcome IS NULL`;
  }

  async feed(accountId: string, cursor: FeedCursor | null, limit: number): Promise<StoredNotification[]> {
    const rows =
      cursor === null
        ? await this.prisma.$queryRaw`
            SELECT notification_id, kind, payload, created_at, read_at FROM notification
            WHERE account_id = ${accountId}::uuid
            ORDER BY created_at DESC, notification_id DESC LIMIT ${limit}`
        : await this.prisma.$queryRaw`
            SELECT notification_id, kind, payload, created_at, read_at FROM notification
            WHERE account_id = ${accountId}::uuid
              AND (created_at, notification_id) < (${cursor.createdAt}, ${cursor.notificationId}::uuid)
            ORDER BY created_at DESC, notification_id DESC LIMIT ${limit}`;
    return z
      .array(rowSchema)
      .parse(rows)
      .map((row) => ({ notificationId: row.notification_id, kind: row.kind, payload: row.payload, createdAt: row.created_at, readAt: row.read_at }));
  }

  async unread(accountId: string): Promise<number> {
    return await this.prisma.notification.count({ where: { accountId, readAt: null } });
  }

  async markRead(accountId: string, upTo: Date | null, at: Date): Promise<void> {
    await this.prisma.notification.updateMany({ where: { accountId, readAt: null, ...(upTo === null ? {} : { createdAt: { lte: upTo } }) }, data: { readAt: at } });
  }

  async createdAtOf(accountId: string, notificationId: string): Promise<Date | null> {
    const row = await this.prisma.notification.findFirst({ where: { accountId, notificationId }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }

  async purge(before: Date, limit: number): Promise<number> {
    // Пачкой по id: DELETE … LIMIT в Postgres нет, а удалять всё разом —
    // держать блокировки на тысячах строк посреди дня.
    return await this.prisma.$executeRaw`
      DELETE FROM notification WHERE notification_id IN (
        SELECT notification_id FROM notification WHERE created_at < ${before} ORDER BY created_at LIMIT ${limit}
      )`;
  }
}
