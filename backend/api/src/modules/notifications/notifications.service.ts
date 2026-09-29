import { Inject, Injectable, Logger } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { NOTIFICATION_KINDS, isNotificationKind, type NotificationKind, type NotificationPayload } from "./notification-kinds.js";
import { NOTIFICATIONS_REPOSITORY, type FeedCursor, type NotificationsRepository } from "./notifications.repository.js";

/**
 * Уведомления игрока (docs/35-stage4-plan.md Р51, §3.17) — порт для
 * доменных модулей и лента для клиента. Модуль пишет уведомление после
 * своего действия и не ждёт его: сбой ленты не должен отменить подарок или
 * добычу, поэтому `post` не бросает, а пишет предупреждение в лог.
 *
 * Одно событие — одно уведомление: ключ события уникален у аккаунта, повтор
 * задания или запроса второй строки не заведёт.
 */

const DB_TIMEOUT_MS = 3_000;
export const FEED_PAGE_DEFAULT = 20;
export const FEED_PAGE_MAX = 50;

export interface NotificationInput<K extends NotificationKind> {
  accountId: string;
  kind: K;
  payload: NotificationPayload<K>;
  /** ключ события: заявка, подарок за сутки, забег */
  dedupeKey: string;
  at?: Date;
}

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  data: unknown;
  createdAt: string;
  read: boolean;
}

export interface FeedView {
  items: NotificationView[];
  nextCursor: string | null;
  unread: number;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("notifications");

  constructor(@Inject(NOTIFICATIONS_REPOSITORY) private readonly repository: NotificationsRepository) {}

  /** Записать и не ждать; `true` — записано, `false` — повтор события или сбой. */
  async notify<K extends NotificationKind>(input: NotificationInput<K>): Promise<boolean> {
    const payload = NOTIFICATION_KINDS[input.kind].safeParse(input.payload);
    if (!payload.success) {
      this.logger.warn(JSON.stringify({ module: "notifications", event: "payload_rejected", kind: input.kind }));
      return false;
    }
    try {
      return await withTimeout(
        this.repository.insert({ accountId: input.accountId, kind: input.kind, payload: payload.data, dedupeKey: input.dedupeKey.slice(0, 160), at: input.at ?? new Date() }),
        DB_TIMEOUT_MS,
        "запись уведомления",
      );
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "notifications", event: "notify_failed", kind: input.kind, reason: error instanceof Error ? error.message : "unknown" }));
      return false;
    }
  }

  /** Для писателей в модулях: действие игрока не ждёт ленту. */
  post<K extends NotificationKind>(input: NotificationInput<K>): void {
    void this.notify(input);
  }

  async feed(accountId: string, cursor: string | undefined, limit = FEED_PAGE_DEFAULT): Promise<FeedView> {
    const from = cursor === undefined ? null : decodeCursor(cursor);
    const size = Math.min(Math.max(1, Math.floor(limit)), FEED_PAGE_MAX);
    // Строкой больше: так видно, есть ли следующая страница, без второго запроса.
    const [rows, unread] = await withTimeout(Promise.all([this.repository.feed(accountId, from, size + 1), this.repository.unread(accountId)]), DB_TIMEOUT_MS, "лента уведомлений");
    const page = rows.slice(0, size);
    const items: NotificationView[] = [];
    for (const row of page) {
      if (!isNotificationKind(row.kind)) continue;
      const data = NOTIFICATION_KINDS[row.kind].safeParse(row.payload);
      if (!data.success) continue;
      items.push({ id: row.notificationId, kind: row.kind, data: data.data, createdAt: row.createdAt.toISOString(), read: row.readAt !== null });
    }
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > size && last !== undefined ? encodeCursor({ createdAt: last.createdAt, notificationId: last.notificationId }) : null, unread };
  }

  async unread(accountId: string): Promise<number> {
    return await withTimeout(this.repository.unread(accountId), DB_TIMEOUT_MS, "непрочитанные уведомления");
  }

  /**
   * Прочитать всё не новее уведомления `upTo`, а без него — всё. Граница — по
   * уведомлению, которое игрок видел: пришедшее, пока он листал, останется
   * непрочитанным.
   */
  async read(accountId: string, upTo: string | undefined, at = new Date()): Promise<{ unread: number }> {
    const until = upTo === undefined ? null : await withTimeout(this.repository.createdAtOf(accountId, upTo), DB_TIMEOUT_MS, "уведомление");
    if (upTo === undefined || until !== null) await withTimeout(this.repository.markRead(accountId, until, at), DB_TIMEOUT_MS, "прочитанные уведомления");
    return { unread: await this.unread(accountId) };
  }
}

export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(`${String(cursor.createdAt.getTime())}:${cursor.notificationId}`, "utf8").toString("base64url");
}

const CURSOR = /^(\d{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function decodeCursor(value: string): FeedCursor {
  const match = CURSOR.exec(Buffer.from(value, "base64url").toString("utf8"));
  if (match?.[1] === undefined || match[2] === undefined) throw new ValidationError("Некорректный курсор ленты");
  return { createdAt: new Date(Number(match[1])), notificationId: match[2] };
}
