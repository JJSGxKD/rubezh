import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Сводка адресов, которые политика источников клиента заблокировала
 * (`/admin/csp-reports`, T-0155). Только директива, хост и число: страницы
 * и данные игроков сервер не хранит и не отдаёт.
 */
export const cspEntrySchema = z.object({
  directive: z.string(),
  host: z.string(),
  count: z.number(),
  lastAt: z.string(),
});

export const cspSummarySchema = z.object({
  entries: z.array(cspEntrySchema),
  overflow: z.number(),
  maxEntries: z.number(),
});

export type CspEntry = z.infer<typeof cspEntrySchema>;
export type CspSummary = z.infer<typeof cspSummarySchema>;

export function fetchCspSummary(api: AdminApi): Promise<ApiResult<CspSummary>> {
  return api.request("/csp-reports", { schema: cspSummarySchema });
}

/** Человеческое имя директивы: `script-src-elem` — «скрипты», незнакомое — как есть. */
const GROUPS: ReadonlyArray<readonly [prefix: string, title: string]> = [
  ["script-src", "скрипты"],
  ["style-src", "стили"],
  ["font-src", "шрифты"],
  ["img-src", "картинки"],
  ["media-src", "ролики"],
  ["frame-src", "фреймы"],
  ["child-src", "фреймы"],
  ["connect-src", "запросы"],
  ["worker-src", "воркеры"],
  ["other", "другое"],
];

export function directiveGroup(directive: string): string {
  return GROUPS.find(([prefix]) => directive.startsWith(prefix))?.[1] ?? directive;
}

const HOST_TITLES: Readonly<Record<string, string>> = {
  inline: "встроенный код",
  eval: "eval",
  data: "data:-адрес",
  blob: "blob:-адрес",
  other: "другое",
};

export function hostTitle(host: string): string {
  return HOST_TITLES[host] ?? host;
}

/**
 * «Свежие» — по времени последнего блокирования; «частые» — по числу, при
 * равенстве выше та, что блокировалась позже. Возвращает новый массив.
 */
export function sortEntries(entries: readonly CspEntry[], order: "fresh" | "count"): CspEntry[] {
  const byLastAt = (a: CspEntry, b: CspEntry) => Date.parse(b.lastAt) - Date.parse(a.lastAt);
  const compare = order === "fresh" ? byLastAt : (a: CspEntry, b: CspEntry) => b.count - a.count || byLastAt(a, b);
  return [...entries].sort(compare);
}
