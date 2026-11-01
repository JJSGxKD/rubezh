import { EMPTY_FILTERS, LIST_SOURCES, type PlayerListFilters, type YesNo } from "../../api/player-list";

/**
 * Фильтры списка игроков чипами (tasks/T-0354): подписи полей формы и чипов
 * берутся из одной таблицы, чтобы они не разошлись. Порядок и направление
 * сортировки — не фильтр, чипов у них нет.
 */

export const FILTER_LABELS = {
  platform: "Площадка",
  level: "Уровень",
  registered: "Регистрация",
  seen: "Заходил",
  source: "Откуда пришёл",
  campaign: "Кампания",
  payer: "Платящий",
  banned: "Заблокирован",
  restricted: "Ограничения",
  canMessage: "Можно писать",
} as const;

export interface FilterChip {
  key: string;
  label: string;
  /** фильтры без этого чипа */
  clear: (filters: PlayerListFilters) => PlayerListFilters;
}

/** Диапазон одним куском: «3–10», «от 3», «до 10»; границы уже в готовом виде. */
function range(from: string, to: string, words: { from: string; to: string }): string {
  if (from !== "" && to !== "") return `${from}–${to}`;
  return from !== "" ? `${words.from} ${from}` : `${words.to} ${to}`;
}

const LEVEL_WORDS = { from: "от", to: "до" };
const DATE_WORDS = { from: "с", to: "по" };

/** `2026-10-15` → `15.10`: год в чипе не нужен, он виден в поле формы. */
function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return month === undefined || day === undefined ? value : `${day}.${month}`;
}

const yesNo = (value: YesNo): string => (value === "yes" ? "да" : "нет");

export function filterChips(filters: PlayerListFilters, kindTitle: (kind: string) => string): FilterChip[] {
  const chips: FilterChip[] = [];
  const add = (key: string, label: string, clear: (current: PlayerListFilters) => PlayerListFilters): void => {
    chips.push({ key, label, clear });
  };
  const level = { min: filters.levelMin.trim(), max: filters.levelMax.trim() };

  if (filters.platform !== "") add("platform", `${FILTER_LABELS.platform}: ${filters.platform}`, (current) => ({ ...current, platform: "" }));
  if (level.min !== "" || level.max !== "") add("level", `${FILTER_LABELS.level}: ${range(level.min, level.max, LEVEL_WORDS)}`, (current) => ({ ...current, levelMin: "", levelMax: "" }));
  if (filters.registeredFrom !== "" || filters.registeredTo !== "") add("registered", `${FILTER_LABELS.registered}: ${range(shortDate(filters.registeredFrom), shortDate(filters.registeredTo), DATE_WORDS)}`, (current) => ({ ...current, registeredFrom: "", registeredTo: "" }));
  if (filters.seenFrom !== "" || filters.seenTo !== "") add("seen", `${FILTER_LABELS.seen}: ${range(shortDate(filters.seenFrom), shortDate(filters.seenTo), DATE_WORDS)}`, (current) => ({ ...current, seenFrom: "", seenTo: "" }));
  if (filters.source !== "") add("source", `${FILTER_LABELS.source}: ${LIST_SOURCES.find(([key]) => key === filters.source)?.[1] ?? filters.source}`, (current) => ({ ...current, source: "" }));
  if (filters.campaign.trim() !== "") add("campaign", `${FILTER_LABELS.campaign}: ${filters.campaign.trim()}`, (current) => ({ ...current, campaign: "" }));
  if (filters.payer !== "") add("payer", `${FILTER_LABELS.payer}: ${yesNo(filters.payer)}`, (current) => ({ ...current, payer: "" }));
  if (filters.banned !== "") add("banned", `${FILTER_LABELS.banned}: ${yesNo(filters.banned)}`, (current) => ({ ...current, banned: "" }));
  if (filters.restricted !== "") {
    const value = filters.restricted === "any" ? "есть" : filters.restricted === "none" ? "нет" : kindTitle(filters.restricted);
    add("restricted", `${FILTER_LABELS.restricted}: ${value}`, (current) => ({ ...current, restricted: "" }));
  }
  if (filters.canMessage !== "") add("canMessage", `${FILTER_LABELS.canMessage}: ${yesNo(filters.canMessage)}`, (current) => ({ ...current, canMessage: "" }));
  return chips;
}

/** Снять все фильтры, порядок оставить: он не фильтр. */
export function clearAllFilters(filters: PlayerListFilters): PlayerListFilters {
  return { ...EMPTY_FILTERS, sort: filters.sort, order: filters.order };
}
