import { randomUUID } from "node:crypto";
import type { FeedCursor, NewNotification, NotificationsRepository, StoredNotification } from "../../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../../src/modules/notifications/notifications.service.js";

/**
 * Уведомления в памяти — для тестов модулей, которые в ленту пишут. Тот же
 * уникальный ключ события, что в базе: повтор не заводит второй строки.
 */
export class MemoryNotificationsRepository implements NotificationsRepository {
  readonly rows: (StoredNotification & { accountId: string; dedupeKey: string })[] = [];

  async insert(notification: NewNotification): Promise<boolean> {
    if (this.rows.some((row) => row.accountId === notification.accountId && row.dedupeKey === notification.dedupeKey)) return false;
    this.rows.push({ ...notification, notificationId: randomUUID(), createdAt: notification.at, readAt: null });
    return true;
  }

  async feed(accountId: string, cursor: FeedCursor | null, limit: number): Promise<StoredNotification[]> {
    return this.rows
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.notificationId < b.notificationId ? 1 : -1))
      .filter((row) => cursor === null || row.createdAt < cursor.createdAt || (row.createdAt.getTime() === cursor.createdAt.getTime() && row.notificationId < cursor.notificationId))
      .slice(0, limit);
  }

  async unread(accountId: string): Promise<number> {
    return this.rows.filter((row) => row.accountId === accountId && row.readAt === null).length;
  }

  async markRead(accountId: string, upTo: Date | null, at: Date): Promise<void> {
    for (const row of this.rows) {
      if (row.accountId === accountId && row.readAt === null && (upTo === null || row.createdAt <= upTo)) row.readAt = at;
    }
  }

  async createdAtOf(accountId: string, notificationId: string): Promise<Date | null> {
    return this.rows.find((row) => row.accountId === accountId && row.notificationId === notificationId)?.createdAt ?? null;
  }

  async purge(before: Date, limit: number): Promise<number> {
    let removed = 0;
    for (let index = this.rows.length - 1; index >= 0 && removed < limit; index--) {
      if ((this.rows[index]?.createdAt ?? before) < before) {
        this.rows.splice(index, 1);
        removed++;
      }
    }
    return removed;
  }

  /** что записано этому аккаунту — вид и данные */
  of(accountId: string): { kind: string; payload: unknown }[] {
    return this.rows.filter((row) => row.accountId === accountId).map((row) => ({ kind: row.kind, payload: row.payload }));
  }
}

export function memoryNotifications(): { service: NotificationsService; repository: MemoryNotificationsRepository } {
  const repository = new MemoryNotificationsRepository();
  return { service: new NotificationsService(repository), repository };
}
