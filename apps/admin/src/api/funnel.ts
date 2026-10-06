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
    case "unknown":
      return { title: "Неизвестно", detail: "нет записи о первом запуске или ссылка незнакомого вида" };
    default:
      return { title: row.startKind, detail: row.startRef };
  }
}
