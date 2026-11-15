/**
 * Правила учёта трафика узлов Xray (docs/35-stage4-plan.md Р192, tasks/T-0386):
 * частота чтения счётчиков, срок хранения, окна отчёта. Ключей панели у них нет —
 * это константы кода (docs/30-configuration-map.md). Чистые функции без базы и сети.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Отчёт за месяц — 30 суток, и запас на то, что корзина последнего часа неполная. */
export const TRAFFIC_RETENTION_DAYS = 35;
/** Раз в минуту: потеря при падении Xray — не больше минуты учёта. */
export const COLLECT_MS = 60_000;
/** Удаление старых корзин — раз в час: 100 узлов дают 2 400 строк в сутки. */
export const CLEANUP_MS = HOUR_MS;
/** Строк, ждущих записи в память процесса: сверх — самые старые отбрасываются. */
export const PENDING_MAX = 10_000;
/** Чтение счётчиков не ждёт Xray дольше: тик расписания идёт под замком рядом с другой работой. */
export const STATS_TIMEOUT_MS = 3_000;
/** Одно и то же предупреждение о сбое — в лог не чаще этого. */
export const LOG_THROTTLE_MS = 10 * 60_000;

/** Окна отчёта — скользящие, в часовых корзинах. */
export const PERIOD_HOURS = { day: 24, week: 168, month: 720 } as const;
export type TrafficPeriod = keyof typeof PERIOD_HOURS;
export const TRAFFIC_PERIODS = ["day", "week", "month"] as const satisfies readonly TrafficPeriod[];

/** Начало часа по UTC: корзина, в которую попадает момент. */
export const hourOf = (at: Date): Date => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

/**
 * Окно отчёта: `PERIOD_HOURS[period]` корзин до текущего часа включительно.
 * `from` — начало первой корзины, `to` — конец текущей (не включён): ровно 24, 168 или 720 часов.
 */
export function windowOf(period: TrafficPeriod, now: Date): { from: Date; to: Date } {
  const current = hourOf(now).getTime();
  return { from: new Date(current - (PERIOD_HOURS[period] - 1) * HOUR_MS), to: new Date(current + HOUR_MS) };
}
