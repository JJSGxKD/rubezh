import { z } from "zod";
import { formatNumber } from "../format";
import type { AdminApi, ApiResult } from "./client";
import { dayTitle } from "./overview";

/**
 * «Чего достигли» — итоги за всё время на экране «Сводка»
 * (`GET /admin/overview/all-time`, tasks/T-0203): аккаунты и кому из них можно
 * писать, сколько человек играло, доход в звёздах и рекорды аудитории. Цифры
 * сервер держит в кеше пять минут, поэтому запрос отдельный: сводка
 * обновляется раз в минуту, а эти итоги — при открытии и по кнопке.
 */

const platformTotalSchema = z.object({ platform: z.string(), total: z.number() });
export type PlatformTotal = z.infer<typeof platformTotalSchema>;

const recordSchema = z.object({ value: z.number(), day: z.string(), now: z.number() });
export type AudienceRecord = z.infer<typeof recordSchema>;

const revenueSchema = z.object({ stars: z.number(), paid: z.number(), refunded: z.number(), purchases: z.number() });
export type AllTimeRevenue = z.infer<typeof revenueSchema>;

export const allTimeSchema = z.object({
  /** когда посчитано, ISO */
  at: z.string(),
  accounts: z.object({ total: z.number(), banned: z.number(), byPlatform: z.array(platformTotalSchema) }),
  reachable: z.object({ total: z.number(), byPlatform: z.array(platformTotalSchema) }),
  played: z.object({ players: z.number(), runs: z.number() }),
  /** `null` — нет права на выручку: плитки дохода нет */
  revenue: revenueSchema.nullable(),
  /** `null` — снимков нет и сегодня никого */
  records: z.object({ dau: recordSchema.nullable(), wau: recordSchema.nullable(), mau: recordSchema.nullable() }),
});
export type AllTime = z.infer<typeof allTimeSchema>;

/** Итоги считаются на сервере до нескольких секунд, когда кеш пуст: ждём дольше обычного запроса. */
const ALL_TIME_TIMEOUT_MS = 30_000;

export function fetchAllTime(api: AdminApi): Promise<ApiResult<AllTime>> {
  return api.request("/overview/all-time", { schema: allTimeSchema, timeoutMs: ALL_TIME_TIMEOUT_MS });
}

/** Названия площадок для людей; порядок — порядок при равных числах. */
const PLATFORM_TITLES: Readonly<Record<string, string>> = { telegram: "Telegram", max: "MAX", vk: "VK", web: "Веб" };
const PLATFORM_ORDER = Object.keys(PLATFORM_TITLES);

/** Незнакомая площадка (сервер новее панели) — в конец, под своим ключом. */
const orderOf = (platform: string): number => {
  const index = PLATFORM_ORDER.indexOf(platform);
  return index === -1 ? PLATFORM_ORDER.length : index;
};

/** «Telegram 1 200 · VK 340»: крупные первыми, площадки с нулём пропускаются, пусто — «пока никого». */
export function platformLine(rows: readonly PlatformTotal[]): string {
  const parts = rows
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || orderOf(a.platform) - orderOf(b.platform) || a.platform.localeCompare(b.platform))
    .map((row) => `${PLATFORM_TITLES[row.platform] ?? row.platform} ${formatNumber(row.total)}`);
  return parts.length === 0 ? "пока никого" : parts.join(" · ");
}

/** Сутки по Москве, на которых сервер посчитал итоги: сервер отдаёт момент, а не сутки. */
function teamDayOf(at: string): string {
  return new Date(Date.parse(at) + 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Когда был рекорд, словами: «14 октября», «31 декабря 2025» (год — если не
 * текущий) или «сегодня, ещё идёт». Сегодня и год — по времени, на которое
 * посчитан ответ, а не по часам браузера: сутки команды московские.
 */
export function recordDate(day: string, at: string): string {
  const today = teamDayOf(at);
  if (day === today) return "сегодня, ещё идёт";
  const year = day.slice(0, 4);
  return year === today.slice(0, 4) ? dayTitle(day) : `${dayTitle(day)} ${year}`;
}

/** «рекорд 5 421 — 14 октября»; рекорда нет — «рекордов пока нет». */
export function recordLine(record: AudienceRecord | null, at: string): string {
  return record === null ? "рекордов пока нет" : `рекорд ${formatNumber(record.value)} — ${recordDate(record.day, at)}`;
}

/** «оплачено 1 500 · возвращено 120 · покупок 12». */
export function starsLine(revenue: AllTimeRevenue): string {
  return `оплачено ${formatNumber(revenue.paid)} · возвращено ${formatNumber(revenue.refunded)} · покупок ${formatNumber(revenue.purchases)}`;
}

/** Доля тех, кому можно писать, целым процентом от всех аккаунтов; аккаунтов нет — 0. */
export function reachableShare(reachable: number, total: number): number {
  return total === 0 ? 0 : Math.round((reachable * 100) / total);
}
