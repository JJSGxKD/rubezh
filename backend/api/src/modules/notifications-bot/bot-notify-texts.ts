import { pluralRu } from "../../common/card/labels.js";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { OutgoingMessage } from "../../platforms/ports/messenger.js";
import { NOTIFICATION_KINDS, type NotificationPayload } from "../notifications/notification-kinds.js";
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

/** `ДД.ММ` по Москве: день оплаты для игрока — по игровым суткам, а не по поясу сервера. */
const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", { timeZone: GAME_DAY_TIME_ZONE, day: "2-digit", month: "2-digit" });

export function botMessageOf(kind: string, payload: unknown, launch: (startParam: string) => string | null): OutgoingMessage | null {
  const text = textOf(kind, payload);
  if (text === null) return null;
  // Сообщения о деньгах участника зовут в панель «Мой проект», а не в игру: кнопка «Открыть игру» тут сбила бы с толку.
  const url = FINANCE_KINDS.has(kind) ? null : launch(`n-${kind}`);
  return { text, button: url === null ? null : { text: OPEN_GAME, url } };
}

const FINANCE_KINDS: ReadonlySet<string> = new Set(["finance_report", "finance_payout"]);

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
    case "purchase_support": {
      const data = NOTIFICATION_KINDS.purchase_support.safeParse(payload);
      return data.success ? purchaseSupportText(data.data) : null;
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
    case "pass_closed": {
      const data = NOTIFICATION_KINDS.pass_closed.safeParse(payload);
      return data.success ? passClosedText(data.data.month, data.data.rewards) : null;
    }
    case "finance_report": {
      const data = NOTIFICATION_KINDS.finance_report.safeParse(payload);
      return data.success ? financeReportText(data.data) : null;
    }
    case "finance_payout": {
      const data = NOTIFICATION_KINDS.finance_payout.safeParse(payload);
      return data.success ? `Выплачено ${rubText(data.data.amountRub)} за ${monthName(data.data.period)}.` : null;
    }
    default:
      return null;
  }
}

/**
 * Извинение за сбой оплаты и возврат звёзд (Р209): на «ты», без давления и без зова в магазин (Р11).
 * Компенсация без самоцветов и возврат без причины — не по смыслу вида: писать нечего.
 */
function purchaseSupportText(data: NotificationPayload<"purchase_support">): string | null {
  const date = DATE_FORMAT.format(new Date(data.paidAt));
  if (data.action === "compensated") {
    if (data.gems === 0) return null;
    const gems = `${String(data.gems)} ${pluralRu(data.gems, "самоцвет", "самоцвета", "самоцветов")}`;
    return `Команда «Рубежа»: прости — с твоей оплатой ${String(data.stars)} ⭐ от ${date} случился сбой на нашей стороне. Мы начислили тебе ${gems}, они уже на счёте в игре.`;
  }
  if (data.reason === null) return null;
  const head = `Команда «Рубежа»: вернули тебе ${String(data.stars)} ⭐ за покупку от ${date}`;
  const body =
    data.reason === "manual"
      ? `${head} по решению поддержки. Звёзды уже на твоём счёте.`
      : `${head} — этого товара больше нет в магазине. Прости за неудобство, звёзды уже на твоём счёте.`;
  return data.revoked ? `${body} Остаток покупки списан со счёта в игре.` : body;
}

/** `ЧЧ:ММ` по Москве: сезон кончается в 03:00, и игроку важно именно московское время. */
function moscowTime(at: Date): string {
  return TIME_FORMAT.format(at);
}

const MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

/** «Пасс октября закрыт: 5 наград зачислено на счёт.» — месяц в родительном падеже, сказуемое согласуется с числом. */
function passClosedText(month: string, rewards: number): string {
  const name = MONTHS_GENITIVE[Number(month.slice(5, 7)) - 1] ?? month;
  const lastTwo = rewards % 100;
  const last = rewards % 10;
  const phrase = last === 1 && lastTwo !== 11 ? "награда зачислена" : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "награды зачислены" : "наград зачислено";
  return `Пасс ${name} закрыт: ${String(rewards)} ${phrase} на счёт.`;
}

const MONTHS_NOMINATIVE = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** «ноябрь» для «за ноябрь»: у всех месяцев винительный падеж совпадает с именительным. */
function monthName(period: string): string {
  return MONTHS_NOMINATIVE[Number(period.slice(5, 7)) - 1] ?? period;
}

/** «15980.40» → «15 980,40 ₽»: тысячи — пробелами, дробная часть — запятой. */
function rubText(amount: string): string {
  const [whole = "0", fraction = "00"] = amount.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/gu, " ")},${fraction} ₽`;
}

/**
 * Отчёт участнику (Р222, T-0469): готов — с его частью и просьбой подтвердить в панели, отозван — с причиной. Готовый
 * отчёт без суммы и отозванный без причины — не по смыслу вида: писать нечего.
 */
function financeReportText(data: NotificationPayload<"finance_report">): string | null {
  const month = monthName(data.period);
  if (data.state === "ready") {
    if (data.amountRub === null) return null;
    return `Отчёт за ${month} готов: твоя часть — ${rubText(data.amountRub)}. Подтверди в панели — без подтверждения выплата ждёт.`;
  }
  if (data.reason === null) return null;
  return `Отчёт за ${month} отозван на пересчёт: ${data.reason.replace(/[.\s]+$/u, "")}.`;
}
