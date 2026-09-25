/**
 * Отображение чисел и времени. В базе и в API всё в UTC; местное время —
 * только здесь, на экране (CLAUDE.md, «Окружение команды»).
 */

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
const NUMBER = new Intl.NumberFormat("ru-RU");

/** Дата ISO или миллисекунды → «25.09.2026, 21:04»; пусто и мусор — прочерк. */
export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_TIME.format(date);
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
