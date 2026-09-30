import { z } from "zod";
import type { AdminApi, ApiResult, QueryValue } from "./client";
import { periodFromDates } from "./funnel";

/**
 * Список игроков с фильтрами (`/admin/players/list`, docs/35-stage4-plan.md
 * WP32): модератор находит игрока по признакам, а не только по имени.
 * Страница — по курсору сервера; общего числа нет: оно стоило бы просмотра
 * всей выборки.
 */

export const LIST_PLATFORMS = ["telegram", "max", "vk", "web"] as const;

/** Откуда пришёл — вид первого касания; подписи — для человека, ключи — сервера. */
export const LIST_SOURCES = [
  ["organic", "сам"],
  ["click", "по ссылке кампании"],
  ["invite", "по приглашению"],
  ["friend", "по ссылке дружбы"],
  ["telegram_affiliate", "партнёрка Telegram"],
  ["notification", "из уведомления бота"],
  ["unknown", "неизвестно"],
] as const;

export const LIST_SORTS = [
  ["registered", "по регистрации"],
  ["seen", "по последнему заходу"],
  ["level", "по уровню"],
] as const;

export type ListSort = (typeof LIST_SORTS)[number][0];
/** «неважно» — пусто: фильтр не уходит на сервер */
export type YesNo = "" | "yes" | "no";

export interface PlayerListFilters {
  platform: "" | (typeof LIST_PLATFORMS)[number];
  levelMin: string;
  levelMax: string;
  /** даты полей формы, `YYYY-MM-DD`; «по» включает день целиком */
  registeredFrom: string;
  registeredTo: string;
  seenFrom: string;
  seenTo: string;
  source: "" | (typeof LIST_SOURCES)[number][0];
  campaign: string;
  payer: YesNo;
  banned: YesNo;
  canMessage: YesNo;
  sort: ListSort;
  order: "desc" | "asc";
}

export const EMPTY_FILTERS: PlayerListFilters = {
  platform: "",
  levelMin: "",
  levelMax: "",
  registeredFrom: "",
  registeredTo: "",
  seenFrom: "",
  seenTo: "",
  source: "",
  campaign: "",
  payer: "",
  banned: "",
  canMessage: "",
  sort: "registered",
  order: "desc",
};

export const playerListItemSchema = z.object({
  accountId: z.string(),
  platform: z.string(),
  displayName: z.string(),
  photoUrl: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  level: z.number(),
  source: z.string().nullable(),
  campaign: z.string().nullable(),
  /** `null` — нет права на выручку */
  payer: z.boolean().nullable(),
  canMessage: z.boolean().nullable(),
  banned: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  pii: z.object({ platformUserId: z.string(), username: z.string().nullable() }).nullable(),
});

export type PlayerListItem = z.infer<typeof playerListItemSchema>;

const listSchema = z.object({ players: z.array(playerListItemSchema), nextCursor: z.string().nullable() });

export const LIST_PAGE = 50;

/** Форма → параметры адреса: пустые поля не уходят, даты — границами дня по местному времени. */
export function listQuery(filters: PlayerListFilters, cursor: string | null): Record<string, QueryValue> {
  const registered = periodFromDates(filters.registeredFrom, filters.registeredTo);
  const seen = periodFromDates(filters.seenFrom, filters.seenTo);
  const text = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());
  return {
    platform: text(filters.platform),
    levelMin: text(filters.levelMin),
    levelMax: text(filters.levelMax),
    registeredFrom: registered.from,
    registeredTo: registered.to,
    seenFrom: seen.from,
    seenTo: seen.to,
    source: text(filters.source),
    campaign: text(filters.campaign.toLowerCase()),
    payer: text(filters.payer),
    banned: text(filters.banned),
    canMessage: text(filters.canMessage),
    sort: filters.sort,
    order: filters.order,
    limit: LIST_PAGE,
    cursor: cursor ?? undefined,
  };
}

/** Что не так с формой; `null` — можно искать. Сервер проверит то же самое. */
export function filtersProblem(filters: PlayerListFilters): string | null {
  const level = (value: string): number | null => (value.trim() === "" ? null : Number(value));
  const min = level(filters.levelMin);
  const max = level(filters.levelMax);
  for (const value of [min, max]) if (value !== null && (!Number.isInteger(value) || value < 1 || value > 999)) return "Уровень — целое число от 1 до 999";
  if (min !== null && max !== null && min > max) return "Уровень «от» больше уровня «до»";
  if (filters.registeredFrom !== "" && filters.registeredTo !== "" && filters.registeredFrom > filters.registeredTo) return "Регистрация «с» позже, чем «по»";
  if (filters.seenFrom !== "" && filters.seenTo !== "" && filters.seenFrom > filters.seenTo) return "Заход «с» позже, чем «по»";
  if (filters.campaign.trim() !== "" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(filters.campaign.trim().toLowerCase())) return "Кампания — латиница, цифры, дефис и подчёркивание";
  return null;
}

export function fetchPlayerList(api: AdminApi, filters: PlayerListFilters, cursor: string | null): Promise<ApiResult<z.infer<typeof listSchema>>> {
  return api.request("/players/list", { query: listQuery(filters, cursor), schema: listSchema });
}

export function sourceLabel(source: string | null): string {
  if (source === null) return "—";
  return LIST_SOURCES.find(([key]) => key === source)?.[1] ?? source;
}
