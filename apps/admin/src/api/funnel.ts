import { z } from "zod";
import { PLATFORM_TITLES } from "./ads";
import type { AdminApi, ApiResult } from "./client";

/**
 * Воронка по источникам за период (`GET /admin/funnel`) — тот же отчёт, что
 * команда `funnel:report` (docs/35-stage4-plan.md, WP2): строка — площадка и
 * первое касание, числа — сколько аккаунтов дошло до каждой вехи. Клики
 * сервер сводит к кампании ссылки, приглашения — в одну строку.
 */
export const funnelRowSchema = z.object({
  platform: z.string(),
  startKind: z.string(),
  startRef: z.string().nullable(),
  startSource: z.string().nullable(),
  accounts: z.number(),
  entered: z.number(),
  appOpened: z.number(),
  firstRunStarted: z.number(),
  firstRunFinished: z.number(),
  runs2: z.number(),
  runs5: z.number(),
  returnedD1: z.number(),
  returnedD7: z.number(),
  firstPurchase: z.number(),
});

export const funnelReportSchema = z.object({ from: z.string(), to: z.string(), rows: z.array(funnelRowSchema) });

export type FunnelRow = z.infer<typeof funnelRowSchema>;
export type FunnelReport = z.infer<typeof funnelReportSchema>;

/** Вехи в порядке воронки — столбцы таблицы. */
export const FUNNEL_STEPS = [
  ["entered", "Вход"],
  ["appOpened", "Открыл"],
  ["firstRunStarted", "1-й забег"],
  ["firstRunFinished", "Закончил"],
  ["runs2", "2 забега"],
  ["runs5", "5 забегов"],
  ["returnedD1", "Вернулся D1"],
  ["returnedD7", "Вернулся D7"],
  ["firstPurchase", "Покупка"],
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number][0];

export interface Period {
  from?: string;
  to?: string;
}

export function fetchFunnel(api: AdminApi, period: Period): Promise<ApiResult<FunnelReport>> {
  return api.request("/funnel", { query: { from: period.from, to: period.to }, schema: funnelReportSchema });
}

/**
 * Даты из полей формы (`YYYY-MM-DD`, местный день) → границы периода в ISO.
 * «По» включает выбранный день целиком: граница — полночь следующего. Пустое
 * поле — без границы, умолчание решает сервер (последние тридцать дней).
 */
export function periodFromDates(fromDate: string, toDate: string): Period {
  const at = (date: string, plusDays: number): string | undefined => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    const local = new Date(year, month - 1, day + plusDays);
    return Number.isNaN(local.getTime()) ? undefined : local.toISOString();
  };
  return { from: at(fromDate, 0), to: at(toDate, 1) };
}

const TOTAL = "все";

/** Итог по всем строкам — первая строка таблицы: общий вид раньше разреза. */
export function funnelTotal(rows: readonly FunnelRow[]): FunnelRow {
  const total: FunnelRow = { platform: TOTAL, startKind: TOTAL, startRef: null, startSource: null, accounts: 0, entered: 0, appOpened: 0, firstRunStarted: 0, firstRunFinished: 0, runs2: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0 };
  for (const row of rows) {
    total.accounts += row.accounts;
    for (const [step] of FUNNEL_STEPS) total[step] += row[step];
  }
  return total;
}

/**
 * Доля от всех аккаунтов строки, целыми процентами — как в `funnel:report`.
 * Не от вошедших в бота: по ссылке кампании игра открывается сразу, минуя
 * бота, и у самой важной строки доли не было бы вовсе.
 */
export function shareOfAccounts(row: FunnelRow, step: FunnelStep): number | null {
  return row.accounts === 0 ? null : Math.round((row[step] / row.accounts) * 100);
}

/** Площадка словами; итог — «все». */
export function platformTitle(platform: string): string {
  return platform === TOTAL ? "все" : ((PLATFORM_TITLES as Partial<Record<string, string>>)[platform] ?? platform);
}

/**
 * Откуда пришли — словами: заголовок и уточнение. Код в базе понятен тому,
 * кто писал разбор параметра запуска (`attribution/start-param.ts`), а не
 * тому, кто сравнивает каналы.
 */
export function touchOf(row: FunnelRow): { title: string; detail: string | null } {
  switch (row.startKind) {
    case TOTAL:
      return { title: "Все источники", detail: null };
    case "organic":
      return { title: "Органика", detail: "без нашей ссылки: меню бота, поиск, история" };
    case "click":
      return row.startRef === null
        ? { title: "Ссылка кампании", detail: "ссылка не найдена — удалена или клик старше неё" }
        : { title: `Кампания «${row.startRef}»`, detail: row.startSource === null ? null : `источник: ${row.startSource}` };
    case "invite":
      return { title: "Приглашение друга", detail: "кнопка «Пригласить» в разделе «Друзья»" };
    case "friend":
      return { title: "Ссылка дружбы", detail: "открыл ссылку игрока — стал его другом" };
    case "telegram_affiliate":
      return { title: "Партнёрская программа Telegram", detail: row.startRef };
    case "notification":
      return { title: "Кнопка уведомления в боте", detail: row.startRef };
    case "tagged":
      return { title: "Ссылка с метками", detail: row.startRef };
    case "unknown":
      return { title: "Неизвестно", detail: "нет записи о первом запуске или ссылка незнакомого вида" };
    default:
      return { title: row.startKind, detail: row.startRef };
  }
}

const DAY_MS = 86_400_000;
const MOSCOW_OFFSET_MS = 3 * 3_600_000;

/** Московские сутки момента — `2026-10-22`: сутки команды не зависят от пояса браузера. */
export function moscowDay(at: Date): string {
  return new Date(at.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

/** Пресет периода от «сейчас»: последние N суток по Москве, сегодня включительно. */
export function presetPeriod(days: 7 | 30 | 90, now: Date): Required<Period> {
  const [year, month, day] = moscowDay(now).split("-").map(Number) as [number, number, number];
  const startOfToday = Date.UTC(year, month - 1, day) - MOSCOW_OFFSET_MS;
  return { from: new Date(startOfToday - (days - 1) * DAY_MS).toISOString(), to: now.toISOString() };
}

/** Прошлый период той же длины, вплотную перед этим. */
export function previousPeriod(period: Required<Period>): Required<Period> {
  const from = new Date(period.from).getTime();
  const length = new Date(period.to).getTime() - from;
  return { from: new Date(from - length).toISOString(), to: period.from };
}

export interface FunnelBar {
  step: FunnelStep;
  title: string;
  count: number;
  /** доля от «Входа», 0…1 */
  ofFirst: number;
  /** доля от прошлой вехи, 0…1; у «Входа» — `null` */
  ofPrev: number | null;
  /** изменение доли от входа к прошлому периоду, п. п. с одним знаком; без сравнения — `null` */
  deltaPts: number | null;
  /** сколько аккаунтов вошло в прошлом периоде — у «Входа» изменение считается в процентах от него */
  countBefore: number | null;
}

/** Полосы по строке «Все источники»; `before` — та же строка прошлого периода или `null`. */
export function funnelBars(total: FunnelRow, before: FunnelRow | null): FunnelBar[] {
  const ratio = (count: number, of: number): number => (of === 0 ? 0 : count / of);
  return FUNNEL_STEPS.map(([step, title], index) => {
    const count = total[step];
    const previous = index === 0 ? null : total[FUNNEL_STEPS[index - 1]?.[0] ?? "entered"];
    const ofFirst = ratio(count, total.entered);
    return {
      step,
      title,
      count,
      ofFirst,
      ofPrev: previous === null ? null : ratio(count, previous),
      deltaPts: before === null ? null : Math.round((ofFirst - ratio(before[step], before.entered)) * 1000) / 10,
      countBefore: before === null ? null : before.entered,
    };
  });
}

/** Сколько первых вех в расчёте «больше всего теряем»: вход … 5 забегов, дальше потеря ожидаема. */
const WORST_STEPS = 6;

/** Индекс вехи с наибольшей потерей от прошлой среди первых шести; потерь нет — `null`. */
export function worstStep(bars: readonly FunnelBar[]): number | null {
  let worst: number | null = null;
  let worstLoss = 0;
  for (let index = 1; index < Math.min(WORST_STEPS, bars.length); index++) {
    const ofPrev = bars[index]?.ofPrev ?? null;
    // Некому было терять, если до прошлой вехи никто не дошёл.
    if (ofPrev === null || (bars[index - 1]?.count ?? 0) === 0) continue;
    const loss = 1 - ofPrev;
    if (loss > worstLoss) {
      worst = index;
      worstLoss = loss;
    }
  }
  return worst;
}

/** Тон ячейки: доля строки против доли «Все источники». */
export function heatTone(share: number, base: number): { tone: "up" | "down" | "flat"; strength: number } {
  const diff = share - base;
  if (Math.abs(diff) < 0.03) return { tone: "flat", strength: 0 };
  return { tone: diff > 0 ? "up" : "down", strength: Math.min(0.3, Math.abs(diff) * 2) };
}

/** Фон ячейки из токенов цвета; без подсветки — `undefined`. */
export function heatBackground(heat: { tone: "up" | "down" | "flat"; strength: number }): string | undefined {
  if (heat.tone === "flat") return undefined;
  const color = heat.tone === "up" ? "--color-success" : "--color-danger";
  return `color-mix(in oklab, var(${color}) ${String(Math.round(heat.strength * 100))}%, transparent)`;
}

/** Строки по убыванию аккаунтов или любой вехи; исходный список не меняется. */
export function sortRows(rows: readonly FunnelRow[], key: "accounts" | FunnelStep): FunnelRow[] {
  return [...rows].sort((a, b) => b[key] - a[key]);
}

/** Площадки из строк ответа, без повторов, в порядке появления. */
export function platformsOf(rows: readonly FunnelRow[]): string[] {
  return [...new Set(rows.map((row) => row.platform))];
}

export function filterByPlatform(rows: readonly FunnelRow[], platform: string | null): FunnelRow[] {
  return platform === null ? [...rows] : rows.filter((row) => row.platform === platform);
}
