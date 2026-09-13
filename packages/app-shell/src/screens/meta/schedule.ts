import { t } from "../../i18n";

/**
 * Когда обновляются ежедневные и недельные задания и награда дня.
 *
 * Сброс — по московскому времени, а не по часам устройства: основная аудитория
 * в РФ, и «новый день» у всех игроков должен наступать одновременно, иначе
 * перевод часов на телефоне даёт лишнюю награду. Смещение постоянное: летнего
 * времени в Москве нет. Сервер хранит всё в UTC, Москва здесь — только граница
 * суток (CLAUDE.md, «Окружение команды»).
 */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;
/** `getUTCDay` понедельника: недельные задания обновляются в ночь на понедельник */
const MONDAY = 1;

export type ResetPeriod = "daily" | "weekly";

/** Сколько миллисекунд до ближайшего сброса после `nowMs`. */
export function msUntilReset(nowMs: number, period: ResetPeriod): number {
  const moscow = nowMs + MOSCOW_OFFSET_MS;
  const startOfDay = Math.floor(moscow / DAY_MS) * DAY_MS;
  if (period === "daily") return startOfDay + DAY_MS - moscow;

  const weekday = new Date(startOfDay).getUTCDay();
  // В сам понедельник следующий сброс — через неделю, а не сейчас.
  const days = (MONDAY - weekday + 7) % 7 || 7;
  return startOfDay + days * DAY_MS - moscow;
}

/**
 * «5 ч 12 мин», «3 д 4 ч», «12 мин» — без нулевых хвостов вроде «1 ч 0 мин».
 * Секунды не показываются: таймер на экране заданий не тикает каждую секунду,
 * и застывшие секунды врали бы.
 */
export function formatCountdown(ms: number): string {
  // Вверх: «через 0 мин» за полминуты до сброса выглядит как ошибка.
  const total = Math.max(1, Math.ceil(ms / MINUTE_MS));
  const days = Math.floor(total / MINUTES_PER_DAY);
  const hours = Math.floor((total % MINUTES_PER_DAY) / 60);
  const minutes = total % 60;

  if (days > 0) {
    return hours > 0 ? t("time.daysHours", { days, hours }) : t("time.days", { days });
  }
  if (hours > 0) {
    return minutes > 0 ? t("time.hoursMinutes", { hours, minutes }) : t("time.hours", { hours });
  }
  return t("time.minutes", { minutes });
}
