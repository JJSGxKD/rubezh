import { z } from "zod";
import { formatNumber } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Сводка — первый экран панели (`GET /admin/overview`, docs/29-admin-panel.md
 * §5.2): сегодня против вчера к тому же часу, две недели по суткам и что ждёт
 * того, кто смотрит. Цифры — те же, что ежедневный отчёт в чат.
 */

const daySchema = z.object({
  accounts: z.record(z.string(), z.number()),
  active: z.number(),
  sessions: z.number(),
  runs: z.object({ finished: z.number(), players: z.number(), medianSurvivalSec: z.number().nullable() }),
  revenue: z.object({ stars: z.number(), purchases: z.number(), refunds: z.number() }).nullable(),
  funnel: z.object({ entered: z.number(), appOpened: z.number(), firstRun: z.number(), runs5: z.number(), returnedD1: z.number(), returnedD7: z.number(), firstPurchase: z.number() }),
});
export type OverviewDay = z.infer<typeof daySchema>;

const overviewSchema = z.object({
  day: z.string(),
  from: z.string(),
  at: z.string(),
  today: daySchema,
  yesterday: daySchema,
  series: z.array(z.object({ day: z.string(), newAccounts: z.number(), active: z.number(), finishedRuns: z.number(), stars: z.number().nullable() })),
  attention: z.array(z.object({ section: z.string(), count: z.number(), text: z.string() })),
});
export type Overview = z.infer<typeof overviewSchema>;

/** Как часто сводка обновляется сама, пока открыта: «Live» — не раз в сутки. */
export const OVERVIEW_REFRESH_MS = 60_000;

export function fetchOverview(api: AdminApi): Promise<ApiResult<Overview>> {
  return api.request("/overview", { schema: overviewSchema });
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/**
 * Сутки сводки словами — «1 октября». Из строки суток сервера, а не из
 * времени браузера: сутки команды — московские, у человека в другом поясе
 * полночь сдвинулась бы на чужой час.
 */
export function dayTitle(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${String(date ?? "")} ${MONTHS[(month ?? 1) - 1] ?? ""}`.trim();
}

export function newAccounts(day: OverviewDay): number {
  return Object.values(day.accounts).reduce((sum, count) => sum + count, 0);
}

/** Откуда пришли новые — словами, крупные первыми: «ссылки 12 · органика 5». */
const SOURCE_TITLES: Readonly<Record<string, string>> = {
  organic: "органика",
  click: "ссылки",
  invite: "приглашения",
  friend: "друзья",
  telegram_affiliate: "партнёрка Telegram",
  unknown: "неизвестно",
};

export function sourcesLine(day: OverviewDay): string {
  const parts = Object.entries(day.accounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([kind, count]) => `${SOURCE_TITLES[kind] ?? kind} ${formatNumber(count)}`);
  return parts.length === 0 ? "пока никого" : parts.join(" · ");
}

/**
 * Сравнение со вчера к тому же часу: «+25%», «−10%», «как вчера». Ноль вчера —
 * не «+∞%», а само вчерашнее число: проценты от нуля ничего не говорят.
 */
export function versusYesterday(today: number, yesterday: number): { text: string; tone: "up" | "down" | "flat" } {
  if (yesterday === 0) return today === 0 ? { text: "как вчера", tone: "flat" } : { text: "вчера к этому часу — 0", tone: "up" };
  const change = Math.round(((today - yesterday) / yesterday) * 100);
  if (change === 0) return { text: "как вчера", tone: "flat" };
  return { text: `${change > 0 ? "+" : "−"}${String(Math.abs(change))}% к вчера`, tone: change > 0 ? "up" : "down" };
}
