import type { FeeInput, OperationInput, OperationKind } from "../../../api/ledger-operations";
import { feeSuggestion, hasFeeTemplate, type Chart, type ChartPlace } from "./preview";

/**
 * Состояние формы операции и его перевод в тело запроса (tasks/T-0464). Поля формы — строки как их ввёл человек;
 * тело собирается по виду операции и содержит только поля этого вида: сервер строгий, лишнее для него опечатка.
 */

export type ReceiptPayer = "none" | "individual" | "legal";

export interface FormState {
  kind: OperationKind;
  /** дата события «ГГГГ-ММ-ДД» */
  at: string;
  note: string;
  link: string;
  /** id картинки снимка чека; `null` — нет */
  receiptImage: string | null;
  from: string;
  to: string;
  article: string;
  amount: string;
  given: string;
  received: string;
  forMonth: string;
  lender: string;
  premium: string;
  /** ставка погашения в процентах: «25» или «12,5» */
  repaymentPercent: string;
  /** ключ проводки, которую исправляем: `op:<id>` */
  sourceKey: string;
  feePercent: string;
  fixedAmount: string;
  fixedCurrency: string;
  fixedFrom: string;
  /** человек правил комиссию руками: шаблон места её больше не подставляет */
  feeEdited: boolean;
  receiptPayer: ReceiptPayer;
  receiptNumber: string;
  receiptLink: string;
}

export function emptyForm(kind: OperationKind, today: string): FormState {
  return {
    kind,
    at: today,
    note: "",
    link: "",
    receiptImage: null,
    from: "",
    to: "",
    article: "",
    amount: "",
    given: "",
    received: "",
    forMonth: today.slice(0, 7),
    lender: "",
    premium: "",
    repaymentPercent: "",
    sourceKey: "",
    feePercent: "",
    fixedAmount: "",
    fixedCurrency: "",
    fixedFrom: "",
    feeEdited: false,
    receiptPayer: "none",
    receiptNumber: "",
    receiptLink: "",
  };
}

/** Сотые доли процента → строка для поля: 2500 → «25», 1250 → «12.5». */
export function percentFromBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  return fraction === 0 ? String(whole) : `${String(whole)}.${String(fraction).padStart(2, "0").replace(/0$/u, "")}`;
}

/** Проценты из поля → сотые доли: «12,5» → 1250; больше 100 % и не число — `null`. */
export function bpFromPercent(raw: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/u.exec(raw.trim());
  if (match === null) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp > 10_000 ? null : bp;
}

/** Форма правки черновика — из ввода, который хранит сервер. Комиссия в нём уже подставлена и не пересчитывается. */
export function formFromInput(input: OperationInput): FormState {
  const base = emptyForm(input.kind, input.at.slice(0, 10));
  return {
    ...base,
    note: input.note,
    link: input.link ?? "",
    receiptImage: input.receiptImage ?? null,
    from: input.from ?? "",
    to: input.to ?? "",
    article: input.article ?? "",
    amount: input.amount ?? "",
    given: input.given ?? "",
    received: input.received ?? "",
    forMonth: input.forMonth ?? base.forMonth,
    lender: input.lender ?? "",
    premium: input.premium ?? "",
    repaymentPercent: input.repaymentBp === undefined ? "" : percentFromBp(input.repaymentBp),
    sourceKey: input.sourceKey ?? "",
    feePercent: input.fee?.amount ?? "",
    fixedAmount: input.fee?.fixed?.amount ?? "",
    fixedCurrency: input.fee?.fixed?.currency ?? "",
    fixedFrom: input.fee?.fixed?.from ?? "",
    feeEdited: true,
    receiptPayer: input.receipt?.payer ?? "none",
    receiptNumber: input.receipt?.number ?? "",
    receiptLink: input.receipt?.link ?? "",
  };
}

export type FormResult = { ok: true; input: OperationInput } | { ok: false; problem: string };

/** Сумма из поля в вид для сервера: пробелы по краям и запятая вместо точки не должны стоить отказа. */
const money = (raw: string): string => raw.trim().replace(",", ".");

function placeOf(chart: Chart, accountId: string): ChartPlace | null {
  return chart.places.find((item) => item.accountId === accountId) ?? null;
}

/**
 * Комиссия перевода и обмена. Поля есть — уходят как есть; полей нет, а у места списания шаблон есть — `{}`:
 * «комиссии нет», иначе сервер подставил бы шаблон сам. Шаблона нет — комиссии в теле нет вовсе.
 */
function feeOf(form: FormState, from: ChartPlace | null): { fee?: FeeInput } | string {
  const fee: FeeInput = {};
  if (form.feePercent.trim() !== "") fee.amount = money(form.feePercent);
  if (form.fixedAmount.trim() !== "") {
    if (form.fixedCurrency === "") return "Фикса комиссии: выберите валюту";
    fee.fixed = { amount: money(form.fixedAmount), currency: form.fixedCurrency, ...(form.fixedFrom === "" ? {} : { from: form.fixedFrom }) };
  }
  if (fee.amount !== undefined || fee.fixed !== undefined) return { fee };
  return hasFeeTemplate(from) ? { fee: {} } : {};
}

/** Чек НПД: только при зачислении в рубли и только если выбран плательщик. */
function receiptOf(form: FormState, destination: ChartPlace | null): { receipt?: NonNullable<OperationInput["receipt"]> } {
  if (form.receiptPayer === "none" || destination?.currency !== "RUB") return {};
  const number = form.receiptNumber.trim();
  const link = form.receiptLink.trim();
  return { receipt: { payer: form.receiptPayer, ...(number === "" ? {} : { number }), ...(link === "" ? {} : { link }) } };
}

/** Тело операции из формы — или название того, чего не хватает. Разбор сумм и правил — дело предпросмотра и сервера. */
export function inputFromForm(form: FormState, chart: Chart): FormResult {
  const common = {
    note: form.note.trim(),
    at: form.at,
    ...(form.link.trim() === "" ? {} : { link: form.link.trim() }),
    ...(form.receiptImage === null ? {} : { receiptImage: form.receiptImage }),
  };
  const missing = (label: string, value: string): FormResult | null => (value.trim() === "" ? { ok: false, problem: `${label}: заполните поле` } : null);
  const need = (...checks: (FormResult | null)[]): FormResult | null => checks.find((check) => check !== null) ?? null;

  switch (form.kind) {
    case "transfer": {
      const absent = need(missing("Откуда", form.from), missing("Куда", form.to), missing("Сумма", form.amount));
      if (absent !== null) return absent;
      const fee = feeOf(form, placeOf(chart, form.from));
      if (typeof fee === "string") return { ok: false, problem: fee };
      return { ok: true, input: { kind: "transfer", ...common, from: form.from, to: form.to, amount: money(form.amount), ...fee } };
    }
    case "exchange": {
      const absent = need(missing("Откуда", form.from), missing("Куда", form.to), missing("Отдано", form.given), missing("Получено", form.received));
      if (absent !== null) return absent;
      const fee = feeOf(form, placeOf(chart, form.from));
      if (typeof fee === "string") return { ok: false, problem: fee };
      return { ok: true, input: { kind: "exchange", ...common, from: form.from, to: form.to, given: money(form.given), received: money(form.received), ...fee, ...receiptOf(form, placeOf(chart, form.to)) } };
    }
    case "expense": {
      const absent = need(missing("Откуда", form.from), missing("Статья", form.article), missing("Сумма", form.amount));
      if (absent !== null) return absent;
      return { ok: true, input: { kind: "expense", ...common, from: form.from, article: form.article, amount: money(form.amount) } };
    }
    case "income": {
      const absent = need(missing("Куда", form.to), missing("Статья", form.article), missing("Сумма", form.amount), missing("Месяц поступления", form.forMonth));
      if (absent !== null) return absent;
      return { ok: true, input: { kind: "income", ...common, to: form.to, article: form.article, amount: money(form.amount), forMonth: form.forMonth, ...receiptOf(form, placeOf(chart, form.to)) } };
    }
    case "loan": {
      const absent = need(missing("Куда", form.to), missing("Кредитор", form.lender), missing("Сумма займа", form.amount), missing("Ставка погашения", form.repaymentPercent));
      if (absent !== null) return absent;
      const bp = bpFromPercent(form.repaymentPercent);
      if (bp === null) return { ok: false, problem: "Ставка погашения: от 0 до 100 %, не больше двух знаков после запятой" };
      return { ok: true, input: { kind: "loan", ...common, to: form.to, lender: form.lender.trim(), amount: money(form.amount), premium: form.premium.trim() === "" ? "0" : money(form.premium), repaymentBp: bp } };
    }
    case "reversal": {
      const absent = missing("Проводка", form.sourceKey);
      if (absent !== null) return absent;
      return { ok: true, input: { kind: "reversal", ...common, sourceKey: form.sourceKey.trim() } };
    }
  }
}

export interface FeeFields {
  feePercent: string;
  fixedAmount: string;
  fixedCurrency: string;
  fixedFrom: string;
}

/** Подсказка комиссии для полей: шаблон места списания от суммы; нет шаблона или суммы — пустые поля. */
export function suggestFee(form: FormState, chart: Chart): FeeFields {
  const suggestion = feeSuggestion(form.kind === "exchange" ? form.given : form.amount, placeOf(chart, form.from));
  return {
    feePercent: suggestion?.amount ?? "",
    fixedAmount: suggestion?.fixed?.amount ?? "",
    fixedCurrency: suggestion?.fixed?.currency ?? "",
    fixedFrom: "",
  };
}
