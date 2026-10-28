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

const periodSchema = z.union([z.literal(1), z.literal(7), z.literal(30)]);
export type OverviewDays = z.infer<typeof periodSchema>;
export const OVERVIEW_PERIODS: readonly OverviewDays[] = [1, 7, 30];

const adsTotalsSchema = z.object({
  offered: z.number(),
  shown: z.number(),
  completed: z.number(),
  claimed: z.number(),
  failed: z.number(),
  /** пропуски VIP (Р99): награда места без ролика, не досмотр; сервер до пропусков поля не отдавал */
  passed: z.number().default(0),
});
export type AdsTotals = z.infer<typeof adsTotalsSchema>;

const overviewAdsSchema = z.object({
  now: adsTotalsSchema,
  before: adsTotalsSchema,
  places: z.array(adsTotalsSchema.extend({ place: z.string() })),
  networks: z.array(z.object({ networkKey: z.string(), completed: z.number() })),
});
export type OverviewAds = z.infer<typeof overviewAdsSchema>;

export const overviewSchema = z.object({
  /** период; сервер без периодов (до T-0051) поля не отдаёт — это были сутки */
  days: periodSchema.default(1),
  day: z.string(),
  from: z.string(),
  at: z.string(),
  today: daySchema,
  yesterday: daySchema,
  series: z.array(
    z.object({
      day: z.string(),
      newAccounts: z.number(),
      active: z.number(),
      finishedRuns: z.number(),
      stars: z.number().nullable(),
      /** `null` — выручка закрыта; старый сервер поля не отдаёт */
      purchases: z.number().nullable().default(null),
      adsCompleted: z.number().default(0),
      /** пропуски VIP за сутки — отдельно от досмотров */
      adsPassed: z.number().default(0),
    }),
  ),
  /** `null` — нет права `ads.view` или чтение рекламы не ответило */
  ads: overviewAdsSchema.nullable().default(null),
  attention: z.array(z.object({ section: z.string(), count: z.number(), text: z.string() })),
});
export type Overview = z.infer<typeof overviewSchema>;

/** Как часто сводка обновляется сама, пока открыта: «Live» — не раз в сутки. */
export const OVERVIEW_REFRESH_MS = 60_000;

export function fetchOverview(api: AdminApi, days: OverviewDays): Promise<ApiResult<Overview>> {
  return api.request("/overview", { query: { days }, schema: overviewSchema });
}

/** Выбранный период из хранилища браузера; мусор и пусто — сутки. */
export function parsePeriod(raw: string | null): OverviewDays {
  const value = Number(raw);
  return value === 7 || value === 30 ? value : 1;
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
  tagged: "ссылки с метками",
  unknown: "неизвестно",
};

export function sourcesLine(day: OverviewDay): string {
  const parts = Object.entries(day.accounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([kind, count]) => `${SOURCE_TITLES[kind] ?? kind} ${formatNumber(count)}`);
  return parts.length === 0 ? "пока никого" : parts.join(" · ");
}

/** Как называется прошлое окно в сравнении: «вчера», «прошлые 7 дней». */
const BEFORE_TEXT: Readonly<Record<OverviewDays, { versus: string; same: string; zero: string }>> = {
  1: { versus: "к вчера", same: "как вчера", zero: "вчера к этому часу — 0" },
  7: { versus: "к прошлым 7 дням", same: "как в прошлые 7 дней", zero: "в прошлые 7 дней — 0" },
  30: { versus: "к прошлым 30 дням", same: "как в прошлые 30 дней", zero: "в прошлые 30 дней — 0" },
};

/**
 * Сравнение с прошлым окном той же длины: «+25% к вчера», «−10% к прошлым 7
 * дням», «как вчера». Ноль в прошлом окне — не «+∞%», а само прошлое число:
 * проценты от нуля ничего не говорят.
 */
export function versusBefore(now: number, before: number, days: OverviewDays = 1): { text: string; tone: "up" | "down" | "flat" } {
  const text = BEFORE_TEXT[days];
  if (before === 0) return now === 0 ? { text: text.same, tone: "flat" } : { text: text.zero, tone: "up" };
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return { text: text.same, tone: "flat" };
  return { text: `${change > 0 ? "+" : "−"}${String(Math.abs(change))}% ${text.versus}`, tone: change > 0 ? "up" : "down" };
}

/** Сдвиг игровых суток `2026-10-07` на `delta` суток по календарю, без часовых поясов. */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + delta)).toISOString().slice(0, 10);
}

/** Заголовок периода: «Сегодня, 7 октября — с полуночи по Москве» или «7 дней — с 1 по 7 октября». */
export function periodTitle(days: OverviewDays, from: string, to: string): string {
  if (days === 1) return `Сегодня, ${dayTitle(to)} — с полуночи по Москве`;
  const start = dayTitle(from);
  const end = dayTitle(to);
  const [, fromMonth] = from.split("-");
  const [, toMonth] = to.split("-");
  const range = fromMonth === toMonth ? `${start.split(" ")[0] ?? ""} по ${end}` : `${start} по ${end}`;
  return `${String(days)} дней — с ${range}`;
}

/** Доля досмотра, целым процентом от показанных; показов нет — `null`. */
export function completionPct(totals: { shown: number; completed: number }): number | null {
  return totals.shown === 0 ? null : Math.round((totals.completed * 100) / totals.shown);
}

/** Ниже порога — тоном предупреждения: сеть не отдаёт ролик или место раздражает игроков. */
export const LOW_COMPLETION_PCT = 60;

const FUNNEL_STEPS: readonly (readonly [keyof OverviewDay["funnel"], string])[] = [
  ["entered", "Вошли в бота"],
  ["appOpened", "Открыли игру"],
  ["firstRun", "Первый забег"],
  ["runs5", "Пятый забег"],
  ["returnedD1", "Вернулись D1"],
  ["returnedD7", "Вернулись D7"],
  ["firstPurchase", "Первая покупка"],
];

/** Вехи полосами: доля от первой вехи (высота полосы) и от прошлой, целым процентом. */
export function funnelBars(funnel: OverviewDay["funnel"]): { key: string; title: string; count: number; ofFirst: number; ofPrev: number | null }[] {
  const first = funnel.entered;
  return FUNNEL_STEPS.map(([key, title], index) => {
    const count = funnel[key];
    const previous = index === 0 ? null : funnel[FUNNEL_STEPS[index - 1]?.[0] ?? "entered"];
    return {
      key,
      title,
      count,
      ofFirst: first === 0 ? 0 : count / first,
      ofPrev: previous === null ? null : previous === 0 ? 0 : Math.round((count * 100) / previous),
    };
  });
}

/** Названия сетей по `networkKey` (ключи — `backend/api/src/modules/ads/ad-networks.ts`); незнакомый — сам ключ. */
const NETWORK_TITLES: Readonly<Record<string, string>> = { adsgram: "AdsGram", adsonar: "AdSonar", richads: "RichAds", taddy: "Taddy" };

export function networkTitle(networkKey: string): string {
  return NETWORK_TITLES[networkKey] ?? networkKey;
}

/** Доли сетей от досмотренных, целыми процентами; сумма — 100 (метод наибольших остатков). */
export function networkShares(networks: readonly { networkKey: string; completed: number }[]): { networkKey: string; pct: number }[] {
  const total = networks.reduce((sum, network) => sum + network.completed, 0);
  if (total === 0) return networks.map((network) => ({ networkKey: network.networkKey, pct: 0 }));
  const exact = networks.map((network, index) => ({ index, share: (network.completed * 100) / total }));
  const floors = exact.map((item) => Math.floor(item.share));
  let left = 100 - floors.reduce((sum, floor) => sum + floor, 0);
  for (const item of [...exact].sort((a, b) => b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)) || a.index - b.index)) {
    if (left <= 0) break;
    floors[item.index] = (floors[item.index] ?? 0) + 1;
    left--;
  }
  return networks.map((network, index) => ({ networkKey: network.networkKey, pct: floors[index] ?? 0 }));
}

/** Пропуски VIP строкой для плитки «Реклама»; их нет — строки нет. */
export function passLine(passed: number): string | null {
  return passed > 0 ? `пропусков VIP ${String(passed)}` : null;
}
