import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { OutgoingMessage } from "../../platforms/ports/messenger.js";
import { NOTIFICATION_KINDS } from "../notifications/notification-kinds.js";
import { REMINDER_OFF_DATA } from "../reminders/reminder-rules.js";
import type { Difficulty } from "../runs/run-rules.js";

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

/**
 * Кнопка под каждым напоминанием (tasks/T-0128): нажатие выключает ключ
 * аккаунта `bot.reminders`. Без неё напоминание не уходит — решает отправитель.
 */
export const REMINDER_OFF_ACTION = { text: "🔕 Не напоминать", data: REMINDER_OFF_DATA } as const;

/**
 * Название сложности в тексте напоминания. Копия словаря оболочки
 * (`difficulty.<id>.name`): собранный бэкенд пакеты клиента не импортирует, а
 * расхождение ловит `reminders.test.ts`.
 */
export const DIFFICULTY_NAMES: Record<Difficulty, string> = { easy: "Обучение", normal: "Нормальная", hard: "Сложная" };

const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: GAME_DAY_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

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
      return data.success ? `${data.data.fromName} зовёт тебя в друзья в «Рубеже». Принять заявку можно в разделе «Друзья».` : null;
    }
    case "friend_gift": {
      const data = NOTIFICATION_KINDS.friend_gift.safeParse(payload);
      return data.success ? `${data.data.fromName} дарит тебе подарок в «Рубеже» — забери его в разделе «Друзья».` : null;
    }
    case "team_message": {
      const data = NOTIFICATION_KINDS.team_message.safeParse(payload);
      return data.success ? `Сообщение команды «Рубежа»:\n\n${data.data.text}` : null;
    }
    // Напоминания пишутся на «ты» и без рода (Р163): «обогнали», «ты теперь», «успей».
    case "season_overtaken": {
      const data = NOTIFICATION_KINDS.season_overtaken.safeParse(payload);
      if (!data.success) return null;
      return `Тебя обогнали в недельном сезоне «Рубежа»: на сложности «${DIFFICULTY_NAMES[data.data.difficulty]}» ты теперь на ${String(data.data.place)}-м месте. До закрытия сезона можно отыграться.`;
    }
    case "season_closing": {
      const data = NOTIFICATION_KINDS.season_closing.safeParse(payload);
      if (!data.success) return null;
      return `Недельный сезон «Рубежа» закрывается завтра в ${moscowTime(new Date(data.data.endsAt))} по Москве. Награды за порог и за место получат те, кто попал в таблицу, — успей улучшить результат.`;
    }
    case "daily_reward_ready": {
      const data = NOTIFICATION_KINDS.daily_reward_ready.safeParse(payload);
      return data.success ? "Награда дня ждёт тебя в «Рубеже». Загляни и забери её сегодня." : null;
    }
    default:
      return null;
  }
}

/** `ЧЧ:ММ` по Москве: сезон кончается в 03:00, и игроку важно именно московское время. */
function moscowTime(at: Date): string {
  return TIME_FORMAT.format(at);
}
