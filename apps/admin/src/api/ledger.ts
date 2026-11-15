import { z } from "zod";
import type { AdminApi, ApiResult, QueryValue } from "./client";

/**
 * Бухгалтерия (`/admin/ledger`, docs/37-accounting.md §9, Р219, tasks/T-0459): остатки по местам хранения и
 * журнал проводок. Суммы приходят строками по знакам валюты — `bigint` в JSON не ходит и дробную часть
 * плавающая точка съела бы; число из них не делается нигде, кроме подписи.
 */
const valuationSchema = z.object({ usd: z.string(), rub: z.string() });

const accountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  type: z.enum(["asset", "revenue", "expense", "liability", "equity"]),
  currency: z.string(),
  balance: z.string(),
  /** оценка по текущим курсам; `null` — для валюты курса нет */
  value: valuationSchema.nullable(),
});

export const balancesSchema = z.object({
  accounts: z.array(accountSchema),
  /** когда сняты курсы; `null` — курсов нет совсем */
  rates: z.object({ at: z.string() }).nullable(),
  /** итог по активам; `null` — у какого-то актива нет оценки */
  totalUsd: z.string().nullable(),
  totalRub: z.string().nullable(),
});

const lineSchema = z.object({ accountId: z.string(), accountName: z.string(), currency: z.string(), amount: z.string() });

const entrySchema = z.object({
  entryId: z.string(),
  sourceKey: z.string(),
  at: z.string(),
  period: z.string(),
  memo: z.string(),
  /** ключ источника исходной проводки, если эта — сторно */
  reversalOf: z.string().nullable(),
  createdBy: z.string().nullable(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  lines: z.array(lineSchema),
});

export const journalPageSchema = z.object({ entries: z.array(entrySchema), next: z.string().nullable() });

export type Balances = z.infer<typeof balancesSchema>;
export type BalanceAccount = Balances["accounts"][number];
export type JournalEntry = z.infer<typeof entrySchema>;
export type JournalPage = z.infer<typeof journalPageSchema>;

/** Фильтры журнала: счёт, валюта, месяцы с/по («ГГГГ-ММ»), префикс ключа источника. Пустая строка — нет фильтра. */
export interface JournalFilter {
  account?: string;
  currency?: string;
  from?: string;
  to?: string;
  source?: string;
}

export function loadBalances(api: AdminApi): Promise<ApiResult<Balances>> {
  return api.request("/ledger/balances", { schema: balancesSchema });
}

/** Параметры запроса журнала: пустые не уходят (сервер строгий), курсор — отдельным параметром. */
export function journalQuery(filter: JournalFilter, cursor: string | null): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const key of ["account", "currency", "from", "to", "source"] as const) {
    const value = filter[key];
    if (value !== undefined && value !== "") query[key] = value;
  }
  if (cursor !== null) query.cursor = cursor;
  return query;
}

export function loadJournal(api: AdminApi, filter: JournalFilter, cursor: string | null): Promise<ApiResult<JournalPage>> {
  return api.request("/ledger/journal", { query: journalQuery(filter, cursor), schema: journalPageSchema });
}

/** Звёзды бота — два счёта одного места: «в холде» и «доступно» (docs/37 §3). */
const STARS_HOLD = "stars.bot.hold";
const STARS_AVAILABLE = "stars.bot.available";

export interface BalanceCards {
  stars: { hold: BalanceAccount | null; available: BalanceAccount | null };
  /** остальные места хранения — кошелёк, биржа, банк и заведённые из панели, в порядке плана счетов */
  others: BalanceAccount[];
}

/** Места хранения — активы: звёзды бота двумя строками, остальные карточками по одному счёту. */
export function balanceCards(accounts: readonly BalanceAccount[]): BalanceCards {
  const assets = accounts.filter((account) => account.type === "asset");
  return {
    stars: {
      hold: assets.find((account) => account.accountId === STARS_HOLD) ?? null,
      available: assets.find((account) => account.accountId === STARS_AVAILABLE) ?? null,
    },
    others: assets.filter((account) => account.accountId !== STARS_HOLD && account.accountId !== STARS_AVAILABLE),
  };
}

/** Выручка по статьям — счета выручки в порядке плана. */
export function revenueRows(accounts: readonly BalanceAccount[]): BalanceAccount[] {
  return accounts.filter((account) => account.type === "revenue");
}

const SYMBOLS: Readonly<Record<string, string>> = { XTR: "⭐", RUB: "₽", USD: "$", EUR: "€" };

/** Типографский минус, чтобы не терялся в таблице. */
const MINUS = "−";

/** Разряды целой части пробелом (неразрывным), дробная — через запятую; строка не превращается в число. */
function groupDigits(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, "\u00a0");
}

/** «114576.00», «RUB» → «114 576,00 ₽»; у валюты без знака — её код: «0,000000 USDT». */
export function formatAmount(amount: string, currency: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(amount);
  if (match === null) return `${amount}\u00a0${SYMBOLS[currency] ?? currency}`;
  const [, sign = "", integer = "0", fraction] = match;
  const text = `${sign === "-" ? MINUS : ""}${groupDigits(integer)}${fraction === undefined ? "" : `,${fraction}`}`;
  return `${text}\u00a0${SYMBOLS[currency] ?? currency}`;
}

/** «1238.90» → «1 238,90»: оценка в долларах и рублях — всегда с копейками. */
export function formatMoney(amount: string): string {
  return formatAmount(amount, "").trimEnd();
}

/** Строка проводки: дебет — плюс, кредит — минус, ноль — без знака. */
export function lineSign(amount: string): string {
  if (/^-0*(\.0*)?$/u.test(amount) || /^\+?0*(\.0*)?$/u.test(amount)) return "0";
  return amount.startsWith("-") ? `${MINUS}${amount.slice(1)}` : `+${amount}`;
}

export type LineTone = "debit" | "credit" | "zero";

export function lineTone(amount: string): LineTone {
  if (lineSign(amount) === "0") return "zero";
  return amount.startsWith("-") ? "credit" : "debit";
}

/** Сторно: метка и ключ исходной проводки, по которому её находят в журнале. */
export function entryNote(entry: JournalEntry): { label: string; original: string } | null {
  return entry.reversalOf === null ? null : { label: "сторно", original: entry.reversalOf };
}

/** Номер покупки из ключа `purchase:<id>:paid|release|refund`; у прочих ключей карточки платежа нет. */
export function paymentIdOf(sourceKey: string): string | null {
  const match = /^purchase:([^:]+):/u.exec(sourceKey);
  return match?.[1] ?? null;
}

/** «Показать ещё»: страница дописывается в конец, повтор по `entryId` отбрасывается (журнал мог пополниться). */
export function mergeEntries(current: readonly JournalEntry[], incoming: readonly JournalEntry[]): JournalEntry[] {
  const seen = new Set(current.map((entry) => entry.entryId));
  return [...current, ...incoming.filter((entry) => !seen.has(entry.entryId))];
}

/** Сумма строки проводки со знаком: «+50 ⭐», «−50 ⭐»; ноль — без знака. */
export function formatLine(amount: string, currency: string): string {
  const tone = lineTone(amount);
  const sign = tone === "debit" ? "+" : tone === "credit" ? MINUS : "";
  return `${sign}${formatAmount(amount.replace(/^-/u, ""), currency)}`;
}

/** Фильтры не заданы: пустой журнал при этом значит «проводок ещё нет», а не «по фильтру ничего». */
export function isFilterEmpty(filter: JournalFilter): boolean {
  return (["account", "currency", "from", "to", "source"] as const).every((key) => (filter[key] ?? "") === "");
}
