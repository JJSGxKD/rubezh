/**
 * Отображение чисел и времени. В базе и в API всё в UTC; местное время —
 * только здесь, на экране (CLAUDE.md, «Окружение команды»).
 */

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
const TIME = new Intl.DateTimeFormat("ru-RU", { timeStyle: "short" });
const NUMBER = new Intl.NumberFormat("ru-RU");

/** Дата ISO или миллисекунды → «25.09.2026, 21:04»; пусто и мусор — прочерк. */
export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_TIME.format(date);
}

/** Только время местное — «21:04»: для «обновлено в», где дата и так сегодняшняя. */
export function formatTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : TIME.format(date);
}

export function formatNumber(value: number): string {
  return NUMBER.format(value);
}

/** Длительность забега: секунды → «7:05» или «1:02:03». */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = String(sec % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Изменение со знаком: «+50», «−20» — минус типографский, чтобы не терялся в таблице. */
export function formatDelta(value: number): string {
  if (value > 0) return `+${formatNumber(value)}`;
  if (value < 0) return `−${formatNumber(-value)}`;
  return "0";
}

/** Склонение числа: 1 монета, 2 монеты, 5 монет. */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** Значение для `datetime-local` в часах браузера: «2026-10-12T18:00». */
export function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
