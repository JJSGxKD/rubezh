/**
 * Ежедневная статистика в чат команды (docs/35-stage4-plan.md §3.18, Р55):
 * сутки по Москве, цифры из базы, сравнение с предыдущими сутками. Здесь —
 * только арифметика суток и текст: без базы, бота и часов, чтобы проверять
 * их тестом без поднятого окружения.
 */

/** Сутки команды — московские: Москва живёт без перехода на летнее время. */
export const TEAM_UTC_OFFSET_MIN = 180;
/** Отчёт за прошедшие сутки — в 00:10: десять минут на запоздавшие записи полуночи. */
export const REPORT_AT_MIN = 10;

const DAY_MS = 86_400_000;
const OFFSET_MS = TEAM_UTC_OFFSET_MIN * 60_000;

export interface DayWindow {
  /** `2026-09-28` — сутки в поясе команды */
  day: string;
  from: Date;
  to: Date;
}

export type SourceKind = "organic" | "click" | "invite" | "telegram_affiliate" | "friend" | "unknown";

export interface DayStats {
  /** новые аккаунты по первому касанию */
  accounts: Partial<Record<SourceKind, number>>;
  /** разных аккаунтов с запуском за сутки */
  active: number;
  sessions: number;
  runs: { finished: number; players: number; medianSurvivalSec: number | null };
  /** только настоящие звёзды: тестовая оплата в выручку не идёт */
  revenue: { stars: number; purchases: number; refunds: number };
  funnel: { entered: number; appOpened: number; firstRun: number; runs5: number; returnedD1: number; returnedD7: number; firstPurchase: number };
}

export function dayWindow(day: string): DayWindow {
  const [year, month, date] = day.split("-").map(Number);
  const from = Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1) - OFFSET_MS;
  return { day, from: new Date(from), to: new Date(from + DAY_MS) };
}

/** Какие сутки в поясе команды идут в этот момент. */
export function teamDay(nowMs: number): string {
  return new Date(nowMs + OFFSET_MS).toISOString().slice(0, 10);
}

export function previousDay(day: string): string {
  return teamDay(dayWindow(day).from.getTime() - DAY_MS);
}

/**
 * За какие сутки отчёт уже положен: до 00:10 — за позавчера, после — за
 * вчера. Пропущенный из-за перезапуска отчёт уходит, как только процесс
 * поднялся, но только за последние сутки: догонять неделю незачем.
 */
export function dueDay(nowMs: number): string {
  const today = teamDay(nowMs);
  const reportAt = dayWindow(today).from.getTime() + REPORT_AT_MIN * 60_000;
  const yesterday = previousDay(today);
  return nowMs >= reportAt ? yesterday : previousDay(yesterday);
}

const SOURCE_LABELS: Record<SourceKind, string> = {
  organic: "органика",
  click: "ссылки",
  invite: "приглашения",
  friend: "друзья",
  telegram_affiliate: "партнёрка Telegram",
  unknown: "неизвестно",
};

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/**
 * Текст отчёта: цифры суток и разница с предыдущими. `before: null` — сутки
 * ещё идут (`/stats`): неполный день против полного дал бы ложную разницу.
 */
export function statsText(day: string, today: DayStats, before: DayStats | null): string {
  const date = new Date(`${day}T00:00:00Z`);
  const when = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} (${WEEKDAYS[date.getUTCDay()]})`;
  const delta = (value: number, previous: number): string => (before === null ? "" : difference(value, previous));
  const newAccounts = total(today.accounts);
  const sources = (Object.keys(SOURCE_LABELS) as SourceKind[])
    .map((kind) => [kind, today.accounts[kind] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${SOURCE_LABELS[kind]} ${count}`);
  const f = today.funnel;
  return [
    before === null ? `📊 Сегодня, ${when}, с полуночи` : `📊 Статистика за ${when}`,
    "",
    `👤 Новых аккаунтов: ${newAccounts}${delta(newAccounts, total(before?.accounts ?? {}))}`,
    ...(sources.length === 0 ? [] : [`   ${sources.join(" · ")}`]),
    `🟢 Активных: ${today.active}${delta(today.active, before?.active ?? 0)} · запусков ${today.sessions}`,
    `🎮 Забегов: ${today.runs.finished}${delta(today.runs.finished, before?.runs.finished ?? 0)} · игроков ${today.runs.players}${today.runs.medianSurvivalSec === null ? "" : ` · медиана ${clock(today.runs.medianSurvivalSec)}`}`,
    `⭐ Выручка: ${today.revenue.stars} ${stars(today.revenue.stars)}${delta(today.revenue.stars, before?.revenue.stars ?? 0)} · покупок ${today.revenue.purchases} · возвратов ${today.revenue.refunds}`,
    `🪜 Воронка: вошли ${f.entered} · открыли игру ${f.appOpened} · первый забег ${f.firstRun} · пять забегов ${f.runs5} · вернулись назавтра ${f.returnedD1}, через неделю ${f.returnedD7} · первая покупка ${f.firstPurchase}`,
  ].join("\n");
}

function total(counts: Partial<Record<SourceKind, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
}

function difference(value: number, before: number): string {
  if (value === before) return " (=)";
  return value > before ? ` (+${value - before})` : ` (−${before - value})`;
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function stars(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "звезда";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "звезды";
  return "звёзд";
}
