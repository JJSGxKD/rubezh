import { pluralRu } from "../../../common/card/labels.js";
import type { DatedRate } from "./period-facts.js";

/**
 * Чек-лист сверки месяца (docs/37-accounting.md §13, Р222, tasks/T-0468): что мешает закрыть и о чём стоит знать.
 * Блокер — закрыть нельзя; предупреждение — закрыть можно, оно остаётся в снимке. Каждый пункт с числом и
 * ссылками (операции, покупки, дни без курса), чтобы владелец шёл к причине, а не искал её. Чистая функция:
 * то, что нашла база, приходит аргументами.
 */

export type ChecklistSeverity = "blocker" | "warning";

export const CHECKLIST_CODES = ["operations_pending", "operations_draft", "payments_unposted", "rate_missing", "shares_over_limit", "receipts_missing", "rate_stale", "npd_limit"] as const;
export type ChecklistCode = (typeof CHECKLIST_CODES)[number];

export type ChecklistRefKind = "operation" | "purchase" | "entry" | "rate";

export interface ChecklistRef {
  kind: ChecklistRefKind;
  /** id операции, покупки или проводки; у курса — «валюта:день» */
  id: string;
}

export interface ChecklistItem {
  code: ChecklistCode;
  severity: ChecklistSeverity;
  /** сколько позиций за пунктом — полное число, а не число ссылок */
  count: number;
  /** по-русски, с числом и падежом */
  message: string;
  refs: ChecklistRef[];
  /** сколько позиций не поместилось в ссылки */
  moreRefs: number;
}

export interface ChecklistInput {
  period: string;
  /** операции месяца, которые ещё не проведены: черновики и ждущие подтверждения */
  openOperations: readonly { operationId: string; status: "draft" | "pending" }[];
  /** живые оплаты месяца без проводки оплаты: сверка платежей отстала */
  unpostedPurchaseIds: readonly string[];
  /** проводки месяца, на дату которых нет курса */
  missingRates: readonly DatedRate[];
  staleRates: readonly DatedRate[];
  /** рублёвые поступления без чека (Р221) */
  receiptsMissing: readonly { entryId: string; operationId: string | null }[];
  npd: { yearReceiptsMinor: bigint; limitRub: number; warnPercent: number };
  /** сумма долей участников на месяц больше 100 %: так в базе быть не может, но закрытие этого не примет */
  sharesOverLimit: boolean;
}

/** Ссылок в пункте не больше этого: остальные считаются числом, а страница сверки не разрастается. */
export const MAX_REFS = 20;

/** Сколько пар «валюта и день» показывается в тексте пункта про курсы. */
const RATES_SHOWN = 5;

function item(code: ChecklistCode, severity: ChecklistSeverity, count: number, message: string, refs: readonly ChecklistRef[]): ChecklistItem {
  return { code, severity, count, message, refs: refs.slice(0, MAX_REFS), moreRefs: Math.max(0, refs.length - MAX_REFS) };
}

/** Рубли из копеек: «1 920 000» и «1 920 000,50» — тысячи пробелом, копейки только если они есть. */
function rubles(minor: bigint): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
  const kopecks = minor % 100n;
  return kopecks === 0n ? whole : `${whole},${kopecks.toString().padStart(2, "0")}`;
}

function ratesText(rates: readonly DatedRate[]): string {
  const shown = rates.slice(0, RATES_SHOWN).map((rate) => `${rate.currency} на ${rate.day}`);
  const more = rates.length > RATES_SHOWN ? ` и ещё ${String(rates.length - RATES_SHOWN)}` : "";
  return `${shown.join(", ")}${more}`;
}

const rateRef = (rate: DatedRate): ChecklistRef => ({ kind: "rate", id: `${rate.currency}:${rate.day}` });

/** Блокеры раньше предупреждений; внутри — в порядке «что чинить сначала». */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const blockers: ChecklistItem[] = [];
  const warnings: ChecklistItem[] = [];

  const pending = input.openOperations.filter((operation) => operation.status === "pending");
  if (pending.length > 0) {
    const text = pluralRu(pending.length, "операция ждёт", "операции ждут", "операций ждут");
    blockers.push(item("operations_pending", "blocker", pending.length, `${String(pending.length)} ${text} подтверждения`, pending.map((operation) => ({ kind: "operation", id: operation.operationId }))));
  }
  const drafts = input.openOperations.filter((operation) => operation.status === "draft");
  if (drafts.length > 0) {
    const text = pluralRu(drafts.length, "черновик операций", "черновика операций", "черновиков операций");
    blockers.push(item("operations_draft", "blocker", drafts.length, `${String(drafts.length)} ${text} в месяце`, drafts.map((operation) => ({ kind: "operation", id: operation.operationId }))));
  }
  if (input.unpostedPurchaseIds.length > 0) {
    const count = input.unpostedPurchaseIds.length;
    const text = pluralRu(count, "оплата", "оплаты", "оплат");
    blockers.push(item("payments_unposted", "blocker", count, `${String(count)} ${text} месяца без проводки — сверка платежей отстала`, input.unpostedPurchaseIds.map((id) => ({ kind: "purchase", id }))));
  }
  if (input.missingRates.length > 0) {
    const count = input.missingRates.length;
    const text = pluralRu(count, "дату", "даты", "дат");
    blockers.push(item("rate_missing", "blocker", count, `Нет курса на ${String(count)} ${text} проводок: ${ratesText(input.missingRates)}`, input.missingRates.map(rateRef)));
  }
  if (input.sharesOverLimit) blockers.push(item("shares_over_limit", "blocker", 1, "Сумма долей участников на этот месяц больше 100 % — закрывать нельзя, пока доли не исправлены", []));

  if (input.receiptsMissing.length > 0) {
    const count = input.receiptsMissing.length;
    const text = pluralRu(count, "рублёвое поступление без чека", "рублёвых поступления без чека", "рублёвых поступлений без чека");
    warnings.push(item("receipts_missing", "warning", count, `${String(count)} ${text}`, input.receiptsMissing.map((receipt) => (receipt.operationId === null ? { kind: "entry", id: receipt.entryId } : { kind: "operation", id: receipt.operationId }))));
  }
  if (input.staleRates.length > 0) {
    const count = input.staleRates.length;
    const text = pluralRu(count, "дату", "даты", "дат");
    warnings.push(item("rate_stale", "warning", count, `Курс старше недели на ${String(count)} ${text} проводок: ${ratesText(input.staleRates)}`, input.staleRates.map(rateRef)));
  }
  const { yearReceiptsMinor, limitRub, warnPercent } = input.npd;
  // sum / limit ≥ warn / 100 в копейках, без дробей: сумма × 100 ≥ лимит × порог
  if (yearReceiptsMinor * 100n >= BigInt(limitRub) * 100n * BigInt(warnPercent)) {
    const reached = (yearReceiptsMinor * 100n) / (BigInt(limitRub) * 100n);
    warnings.push(
      item(
        "npd_limit",
        "warning",
        1,
        `Чеки ${input.period.slice(0, 4)} года — ${rubles(yearReceiptsMinor)} ₽ из лимита НПД ${rubles(BigInt(limitRub) * 100n)} ₽ (${reached.toString()} %); порог предупреждения — ${String(warnPercent)} %`,
        [],
      ),
    );
  }
  return [...blockers, ...warnings];
}

export function hasBlockers(items: readonly ChecklistItem[]): boolean {
  return items.some((checklistItem) => checklistItem.severity === "blocker");
}
