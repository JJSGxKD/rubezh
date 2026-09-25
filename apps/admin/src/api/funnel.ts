import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Воронка по источникам за период (`GET /admin/funnel`) — тот же отчёт, что
 * команда `funnel:report` (docs/35-stage4-plan.md, WP2): строка — площадка и
 * первое касание, числа — сколько аккаунтов дошло до каждой вехи.
 */
export const funnelRowSchema = z.object({
  platform: z.string(),
  startKind: z.string(),
  startRef: z.string().nullable(),
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

/** Итог по всем строкам — первая строка таблицы: общий вид раньше разреза. */
export function funnelTotal(rows: readonly FunnelRow[]): FunnelRow {
  const total: FunnelRow = { platform: "все", startKind: "все", startRef: null, accounts: 0, entered: 0, appOpened: 0, firstRunStarted: 0, firstRunFinished: 0, runs2: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0 };
  for (const row of rows) {
    total.accounts += row.accounts;
    for (const [step] of FUNNEL_STEPS) total[step] += row[step];
  }
  return total;
}

/** Доля от вошедших, целыми процентами; без вошедших — `null`, а не деление на ноль. */
export function shareOfEntered(row: FunnelRow, step: FunnelStep): number | null {
  return row.entered === 0 ? null : Math.round((row[step] / row.entered) * 100);
}
