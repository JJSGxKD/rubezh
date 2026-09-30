import type { OutgoingMessage } from "../../platforms/ports/messenger.js";
import { NOTIFICATION_KINDS } from "../notifications/notification-kinds.js";

/**
 * Тексты дубля уведомлений в бота (docs/35-stage4-plan.md WP28). Простым
 * текстом, без разметки: имя друга пишет игрок, сообщение команды — панель, и
 * любой из них сломал бы разметку. Имя — как в ленте, копией на момент
 * события; глаголы — в настоящем времени, у них нет рода.
 *
 * Кнопка ведёт в игру с параметром `n-<вид>` (`attribution/start-param.ts`):
 * по сессиям видно, возвращают ли сообщения бота. Нет ссылки — сообщение
 * уходит без кнопки: бот ещё не узнал своё имя, а новость важнее кнопки.
 */

const OPEN_GAME = "▶ Открыть игру";

export function botMessageOf(kind: string, payload: unknown, launch: (startParam: string) => string | null): OutgoingMessage | null {
  const text = textOf(kind, payload);
  if (text === null) return null;
  const url = launch(`n-${kind}`);
  return { text, button: url === null ? null : { text: OPEN_GAME, url } };
}

/** Данные пришли из очереди — граница, поэтому схемой вида. Не по схеме — `null`, писать нечего. */
function textOf(kind: string, payload: unknown): string | null {
  switch (kind) {
    case "friend_request": {
      const data = NOTIFICATION_KINDS.friend_request.safeParse(payload);
      return data.success ? `${data.data.fromName} зовёт вас в друзья в «Рубеже». Принять заявку можно в разделе «Друзья».` : null;
    }
    case "friend_gift": {
      const data = NOTIFICATION_KINDS.friend_gift.safeParse(payload);
      return data.success ? `${data.data.fromName} дарит вам подарок в «Рубеже» — заберите его в разделе «Друзья».` : null;
    }
    case "team_message": {
      const data = NOTIFICATION_KINDS.team_message.safeParse(payload);
      return data.success ? `Сообщение команды «Рубежа»:\n\n${data.data.text}` : null;
    }
    case "app_update": {
      const data = NOTIFICATION_KINDS.app_update.safeParse(payload);
      return data.success ? `Вышло обновление «Рубежа» — версия ${data.data.version}. Что изменилось — в игре, в меню «Что нового».` : null;
    }
    default:
      return null;
  }
}
