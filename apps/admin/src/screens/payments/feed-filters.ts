import type { QueryValue } from "../../api/client";
import { periodFromDates } from "../../api/funnel";
import { FEED_STATUSES, MODES, PLATFORMS, PRODUCTS, titleOf, type FeedMode, type FeedPlatform, type FeedProduct, type FeedStatus } from "../../api/payments";

/**
 * Фильтры ленты платежей (tasks/T-0437): чистые правила — запрос к серверу,
 * чипы активных фильтров и проверка поиска. Подписи полей формы и чипов
 * берутся из одной таблицы, чтобы они не разошлись.
 */

export interface FeedFilters {
  status: "" | FeedStatus;
  product: "" | FeedProduct;
  platform: "" | FeedPlatform;
  mode: "" | FeedMode;
  /** даты полей формы, `YYYY-MM-DD`: период по дате счёта; «по» включает день целиком */
  from: string;
  to: string;
  /** игрок — по идентификатору аккаунта; имя нужно только для чипа */
  account: string;
  accountName: string;
  /** номер покупки или идентификатор оплаты — целиком */
  q: string;
}

export const EMPTY_FEED_FILTERS: FeedFilters = { status: "", product: "", platform: "", mode: "", from: "", to: "", account: "", accountName: "", q: "" };

export const FEED_FILTER_LABELS = {
  status: "Состояние",
  product: "Товар",
  platform: "Площадка",
  mode: "Режим",
  period: "Период",
  account: "Игрок",
} as const;

export interface FeedChip {
  key: string;
  label: string;
  /** фильтры без этого чипа */
  clear: (filters: FeedFilters) => FeedFilters;
}

/** `2026-11-01` → `01.11`: год в чипе не нужен, он виден в поле формы. */
function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return month === undefined || day === undefined ? value : `${day}.${month}`;
}

function periodText(from: string, to: string): string {
  if (from !== "" && to !== "") return `${shortDate(from)}–${shortDate(to)}`;
  return from !== "" ? `с ${shortDate(from)}` : `по ${shortDate(to)}`;
}

export function feedChips(filters: FeedFilters): FeedChip[] {
  const chips: FeedChip[] = [];
  const add = (key: string, label: string, clear: (current: FeedFilters) => FeedFilters): void => {
    chips.push({ key, label, clear });
  };
  if (filters.status !== "") add("status", `${FEED_FILTER_LABELS.status}: ${titleOf(FEED_STATUSES, filters.status)}`, (current) => ({ ...current, status: "" }));
  if (filters.product !== "") add("product", `${FEED_FILTER_LABELS.product}: ${titleOf(PRODUCTS, filters.product)}`, (current) => ({ ...current, product: "" }));
  if (filters.platform !== "") add("platform", `${FEED_FILTER_LABELS.platform}: ${titleOf(PLATFORMS, filters.platform)}`, (current) => ({ ...current, platform: "" }));
  if (filters.mode !== "") add("mode", `${FEED_FILTER_LABELS.mode}: ${titleOf(MODES, filters.mode)}`, (current) => ({ ...current, mode: "" }));
  if (filters.from !== "" || filters.to !== "") add("period", `${FEED_FILTER_LABELS.period}: ${periodText(filters.from, filters.to)}`, (current) => ({ ...current, from: "", to: "" }));
  if (filters.account !== "") add("account", `${FEED_FILTER_LABELS.account}: ${filters.accountName === "" ? filters.account.slice(0, 8) : filters.accountName}`, (current) => ({ ...current, account: "", accountName: "" }));
  return chips;
}

/** Форма → параметры адреса: пустые не уходят, даты — границами дня по местному времени. */
export function feedQuery(filters: FeedFilters): Record<string, QueryValue> {
  const period = periodFromDates(filters.from, filters.to);
  const text = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());
  const query: Record<string, QueryValue> = {
    status: text(filters.status),
    product: text(filters.product),
    platform: text(filters.platform),
    mode: text(filters.mode),
    from: period.from,
    to: period.to,
    account: text(filters.account),
    q: text(filters.q),
  };
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
}

/** Лента одного игрока — по ссылке из карточки игрока. */
export function filtersFromAccount(accountId: string, name: string): FeedFilters {
  return { ...EMPTY_FEED_FILTERS, account: accountId, accountName: name };
}

/** Что не так с формой фильтров; `null` — можно показывать. Сервер проверит то же самое. */
export function filtersProblem(filters: FeedFilters): string | null {
  if (filters.from !== "" && filters.to !== "" && filters.from > filters.to) return "Период «с» позже, чем «по»";
  return null;
}

/** Короче восьми знаков сервер поиск не принимает (частичного поиска нет). */
export function searchProblem(q: string): string | null {
  const length = q.trim().length;
  return length >= 1 && length < 8 ? "Номер покупки или идентификатор оплаты — от 8 знаков" : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Карточка — только по номеру покупки: слова `discrepancies` и `jobs` во второй части адреса заняты под вкладки. */
export function isPurchaseId(id: string | null): id is string {
  return id !== null && UUID.test(id);
}
