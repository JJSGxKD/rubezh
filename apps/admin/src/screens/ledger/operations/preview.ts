import type { ArticleView, EntryView, FeeInput, FeeTemplateView, OperationInput, OperationKind, PlaceView } from "../../../api/ledger-operations";
import { NOTE_MAX, NOTE_MIN } from "../../../api/ledger-operations";
import { CURRENCY_DECIMALS, fromMinor, toMinor } from "./money";

/**
 * Предпросмотр проводки (docs/37-accounting.md §4, §6, tasks/T-0464): строки, которые создаст сервер, — по тем же
 * правилам, что его сборщики (`backend/api/src/modules/ledger/operations/builders.ts`). Это подсказка человеку
 * до отправки, а не проводка: настоящую собирает и проверяет сервер, расхождение — его текстом ошибки.
 */

/** Место хранения как счёт: у звёзд бота холд и «доступно» — два места одной группы. */
export interface ChartPlace {
  accountId: string;
  name: string;
  currency: string;
  /** идентификатор места-группы (`stars.bot`) */
  group: string;
  archived: boolean;
  fee: FeeTemplateView | null;
}

export interface Chart {
  places: readonly ChartPlace[];
  articles: readonly ArticleView[];
}

export function flattenPlaces(places: readonly PlaceView[]): ChartPlace[] {
  return places.flatMap((place) =>
    place.accounts.map((account) => ({ accountId: account.accountId, name: account.name, currency: place.currency, group: place.placeId, archived: place.archived, fee: place.fee })),
  );
}

export interface PreviewLine {
  accountName: string;
  currency: string;
  /** со знаком: плюс — дебет, минус — кредит; десятичной строкой */
  amount: string;
}

export type Preview = { ok: true; lines: PreviewLine[] } | { ok: false; problems: string[] };

const SYMBOLS: Readonly<Record<string, string>> = { XTR: "⭐", RUB: "₽", USD: "$", EUR: "€" };
const symbolOf = (currency: string): string => SYMBOLS[currency] ?? currency;

/** Раньше учёта в проекте событий не бывает: дата до этого дня — опечатка в годе. */
const EARLIEST_DAY = Date.UTC(2026, 0, 1);
/** Статьи комиссий: у перевода — комиссия вывода, у обмена — комиссия обмена. */
const FEE_ARTICLE = { transfer: "fee_withdrawal", exchange: "fee_exchange" } as const;

/** Настоящий день календаря: 31 февраля — не дата. Время и пояс, если есть, разбирает сервер. */
function parseDay(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(raw);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

function commonProblems(input: OperationInput, now: Date): string[] {
  const problems: string[] = [];
  const note = input.note.trim();
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) problems.push(`Причина: от ${String(NOTE_MIN)} до ${String(NOTE_MAX)} знаков`);
  const day = parseDay(input.at);
  if (day === null) problems.push(`Дата «${input.at}» не существует`);
  else if (day < EARLIEST_DAY) problems.push("Дата события раньше 1 января 2026 года: учёт начинается с этого дня");
  else if (day > now.getTime()) problems.push("Дата события в будущем: учёт записывает то, что уже случилось");
  return problems;
}

type Mode = "positive" | "nonnegative";

class Assembly {
  readonly problems: string[] = [];
  private readonly sums = new Map<string, PreviewLine & { minor: bigint }>();

  constructor(
    readonly chart: Chart,
    now: Date,
    input: OperationInput,
  ) {
    this.problems.push(...commonProblems(input, now));
  }

  place(accountId: string | undefined, label: string): ChartPlace | null {
    if (accountId === undefined || accountId === "") {
      this.problems.push(`${label}: выберите место хранения`);
      return null;
    }
    const place = this.chart.places.find((item) => item.accountId === accountId);
    if (place === undefined) {
      this.problems.push(`${label}: места хранения «${accountId}» нет`);
      return null;
    }
    if (place.archived) {
      this.problems.push(`${label}: место «${place.name}» в архиве — проводок по нему больше нет`);
      return null;
    }
    return place;
  }

  article(articleId: string | undefined, kind: "expense" | "income"): ArticleView | null {
    if (articleId === undefined || articleId === "") {
      this.problems.push("Статья: выберите статью");
      return null;
    }
    const article = this.chart.articles.find((item) => item.articleId === articleId);
    if (article === undefined) {
      this.problems.push(`Статьи «${articleId}» нет`);
      return null;
    }
    if (article.kind !== kind) {
      this.problems.push(`Статья «${article.name}» — не из статей ${kind === "expense" ? "расходов" : "поступлений"}`);
      return null;
    }
    if (article.archived) {
      this.problems.push(`Статья «${article.name}» в архиве — новых проводок по ней нет`);
      return null;
    }
    return article;
  }

  amount(raw: string | undefined, currency: string, label: string, mode: Mode = "positive"): bigint | null {
    const text = (raw ?? "").trim();
    if (text === "") {
      this.problems.push(`${label}: введите сумму`);
      return null;
    }
    const value = toMinor(text, currency);
    if (value === null) {
      this.problems.push(`${label}: число без знака, у ${currency} — до ${String(CURRENCY_DECIMALS[currency] ?? 0)} знаков после запятой`);
      return null;
    }
    if (value === 0n && mode === "positive") {
      this.problems.push(`${label}: сумма должна быть больше нуля`);
      return null;
    }
    return value;
  }

  add(key: string, name: string, currency: string, minor: bigint): void {
    const current = this.sums.get(key);
    this.sums.set(key, { accountName: name, currency, amount: "", minor: (current?.minor ?? 0n) + minor });
  }

  articleLine(article: ArticleView, currency: string, minor: bigint): void {
    this.add(`${article.kind}.${article.articleId}.${currency}`, `${article.name}, ${symbolOf(currency)}`, currency, minor);
  }

  /** Комиссии: процент — с места списания, фикса — с места своей валюты; каждая — строка плательщика и строка статьи. */
  fees(kind: "transfer" | "exchange", fee: FeeInput | undefined, from: ChartPlace): void {
    const charges: { currency: string; minor: bigint; payer: ChartPlace }[] = [];
    if (fee?.amount !== undefined) {
      const minor = this.amount(fee.amount, from.currency, "Комиссия", "nonnegative");
      if (minor !== null && minor > 0n) charges.push({ currency: from.currency, minor, payer: from });
    }
    if (fee?.fixed !== undefined) {
      const minor = this.amount(fee.fixed.amount, fee.fixed.currency, "Фикса комиссии", "nonnegative");
      if (minor !== null && minor > 0n) {
        const payer = this.fixedPayer(fee.fixed, from);
        if (payer !== null) charges.push({ currency: fee.fixed.currency, minor, payer });
      }
    }
    const article = this.chart.articles.find((item) => item.articleId === FEE_ARTICLE[kind]);
    if (charges.length > 0 && article === undefined) {
      this.problems.push(`Статьи комиссии «${FEE_ARTICLE[kind]}» нет в справочнике: комиссию некуда отнести`);
      return;
    }
    for (const charge of charges) {
      this.add(charge.payer.accountId, charge.payer.name, charge.payer.currency, -charge.minor);
      if (article !== undefined) this.articleLine(article, charge.currency, charge.minor);
    }
  }

  /** Фикса в чужой валюте — другое место: названное явно, а без названия — единственное в этой валюте. */
  private fixedPayer(fixed: NonNullable<FeeInput["fixed"]>, from: ChartPlace): ChartPlace | null {
    if (fixed.from !== undefined && fixed.from !== "") {
      const place = this.place(fixed.from, "Фикса комиссии");
      if (place !== null && place.currency !== fixed.currency) {
        this.problems.push(`Фикса комиссии: место «${place.name}» — в валюте ${place.currency}, а фикса — в ${fixed.currency}`);
        return null;
      }
      return place;
    }
    if (fixed.currency === from.currency) return from;
    const candidates = this.chart.places.filter((item) => !item.archived && item.currency === fixed.currency);
    const [only] = candidates;
    if (only === undefined) {
      this.problems.push(`Нет места в валюте фиксы ${fixed.currency}: комиссию не с чего списать — нужно завести место хранения в этой валюте`);
      return null;
    }
    if (candidates.length > 1) {
      this.problems.push(`В валюте фиксы ${fixed.currency} несколько мест (${candidates.map((item) => `«${item.name}»`).join(", ")}) — нужно указать, с какого списать фиксу`);
      return null;
    }
    return only;
  }

  finish(): Preview {
    if (this.problems.length > 0) return { ok: false, problems: this.problems };
    const lines = [...this.sums.values()].filter((line) => line.minor !== 0n).map((line) => ({ accountName: line.accountName, currency: line.currency, amount: fromMinor(line.minor, line.currency) }));
    return { ok: true, lines };
  }
}

/** Месяц события «ГГГГ-ММ»; даты вне календаря не бывает — её уже назвала общая проверка. */
function periodOf(raw: string): string | null {
  return parseDay(raw) === null ? null : raw.slice(0, 7);
}

/** Строки проводки, которые создаст сервер, — или всё, что мешает их собрать, разом. */
export function previewOf(input: OperationInput, chart: Chart, now: Date = new Date()): Preview {
  const a = new Assembly(chart, now, input);
  switch (input.kind) {
    case "transfer": {
      const from = a.place(input.from, "Откуда");
      const to = a.place(input.to, "Куда");
      if (from !== null && to !== null) {
        if (from.accountId === to.accountId) a.problems.push("Откуда и куда — одно и то же место");
        else if (from.currency !== to.currency) a.problems.push(`Перевод — в одной валюте: у «${from.name}» это ${from.currency}, у «${to.name}» — ${to.currency}; для разных валют есть обмен`);
      }
      if (from === null || to === null) return a.finish();
      const amount = a.amount(input.amount, from.currency, "Сумма");
      if (amount !== null) {
        a.add(from.accountId, from.name, from.currency, -amount);
        a.add(to.accountId, to.name, to.currency, amount);
      }
      a.fees("transfer", input.fee, from);
      return a.finish();
    }
    case "exchange": {
      const from = a.place(input.from, "Откуда");
      const to = a.place(input.to, "Куда");
      if (from !== null && to !== null && from.currency === to.currency) {
        a.problems.push(`Обмен — между разными валютами, а у «${from.name}» и «${to.name}» это ${from.currency}: для одной валюты есть перевод`);
      }
      if (from === null || to === null) return a.finish();
      const given = a.amount(input.given, from.currency, "Отдано");
      const received = a.amount(input.received, to.currency, "Получено");
      if (given !== null && received !== null) {
        const transit = (currency: string) => [`exchange.transit.${currency}`, `Обмен (транзит), ${currency}`] as const;
        a.add(from.accountId, from.name, from.currency, -given);
        a.add(transit(from.currency)[0], transit(from.currency)[1], from.currency, given);
        a.add(transit(to.currency)[0], transit(to.currency)[1], to.currency, -received);
        a.add(to.accountId, to.name, to.currency, received);
      }
      a.fees("exchange", input.fee, from);
      return a.finish();
    }
    case "expense": {
      const from = a.place(input.from, "Откуда");
      const article = a.article(input.article, "expense");
      if (from === null) return a.finish();
      const amount = a.amount(input.amount, from.currency, "Сумма");
      if (amount !== null && article !== null) {
        a.add(from.accountId, from.name, from.currency, -amount);
        a.articleLine(article, from.currency, amount);
      }
      return a.finish();
    }
    case "income": {
      const to = a.place(input.to, "Куда");
      const article = a.article(input.article, "income");
      const month = input.forMonth ?? "";
      const eventMonth = periodOf(input.at);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) a.problems.push("Месяц поступления: выберите месяц");
      else if (eventMonth !== null && month > eventMonth) a.problems.push(`Месяц поступления ${month} позже месяца даты операции`);
      if (input.receipt !== undefined && to !== null && to.currency !== "RUB") a.problems.push(`Чек НПД заводится при зачислении в рубли: у места «${to.name}» валюта ${to.currency}`);
      if (to === null) return a.finish();
      const amount = a.amount(input.amount, to.currency, "Сумма");
      if (amount !== null && article !== null) {
        a.add(to.accountId, to.name, to.currency, amount);
        a.articleLine(article, to.currency, -amount);
      }
      return a.finish();
    }
    case "loan": {
      const to = a.place(input.to, "Куда");
      const lender = (input.lender ?? "").trim();
      if (!/[\p{L}\p{N}]/u.test(lender)) a.problems.push("Кредитор: нужны буквы или цифры");
      const bp = input.repaymentBp;
      if (bp === undefined || !Number.isInteger(bp) || bp < 0 || bp > 10_000) a.problems.push("Ставка погашения — доля чистой прибыли от 0 до 100 % (от 0 до 10 000 сотых процента)");
      if (to === null) return a.finish();
      const principal = a.amount(input.amount, to.currency, "Сумма займа");
      a.amount(input.premium ?? "0", to.currency, "Премия", "nonnegative");
      if (principal !== null) {
        a.add(to.accountId, to.name, to.currency, principal);
        a.add(`loan:${lender}:${to.currency}`, `Заём: ${lender}, ${symbolOf(to.currency)}`, to.currency, -principal);
      }
      return a.finish();
    }
    case "reversal":
      // Строки исходной проводки у панели есть только после выбора операции: см. `reversalPreview`.
      return a.problems.length > 0 ? { ok: false, problems: a.problems } : { ok: true, lines: [] };
  }
}

/** Знак числа-строки наоборот: «−1500.00» → «1500.00»; ноль остаётся нулём. */
function negate(amount: string): string {
  if (/^-?0*(\.0*)?$/u.test(amount)) return amount.replace(/^-/u, "");
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

/** Исправление — сторно: строки исходной проводки с обратными знаками. */
export function reversalPreview(lines: EntryView["lines"]): PreviewLine[] {
  return lines.map((line) => ({ accountName: line.accountName, currency: line.currency, amount: negate(line.amount) }));
}

const BASIS = 10_000n;

/**
 * Комиссия по шаблону места списания от суммы: процент — вверх до единицы валюты (комиссию не занижаем), фикса —
 * как записана в шаблоне. Подсказка для полей формы: человек правит её руками, и уходит то, что в полях.
 */
export function feeSuggestion(amount: string, place: ChartPlace | null): FeeInput | null {
  const template = place?.fee ?? null;
  if (place === null || template === null) return null;
  const minor = toMinor(amount, place.currency);
  if (minor === null || minor <= 0n) return null;
  const suggestion: { amount?: string; fixed?: { amount: string; currency: string } } = {};
  if (template.percentBp !== null && template.percentBp > 0) {
    suggestion.amount = fromMinor((minor * BigInt(template.percentBp) + BASIS - 1n) / BASIS, place.currency);
  }
  if (template.fixed !== null && template.fixedCurrency !== null) {
    const fixed = toMinor(template.fixed, template.fixedCurrency);
    if (fixed !== null && fixed > 0n) suggestion.fixed = { amount: template.fixed, currency: template.fixedCurrency };
  }
  return suggestion.amount === undefined && suggestion.fixed === undefined ? null : suggestion;
}

/** Есть ли у места шаблон комиссии: если есть, пустые поля формы означают «комиссии нет». */
export function hasFeeTemplate(place: ChartPlace | null): boolean {
  const template = place?.fee ?? null;
  return template !== null && ((template.percentBp ?? 0) > 0 || (template.fixed !== null && template.fixedCurrency !== null));
}

export interface Outlook {
  verdict: "immediate" | "pending" | "unknown";
  text: string;
}

export interface OutlookInput {
  kind: OperationKind;
  /** оценка в долларах, как у сервера; `null` — курса не было; `undefined` — операция ещё не сохранена, оценки нет */
  amountUsd: string | null | undefined;
  /** у вошедшего есть право подтверждать (`finance.operation.approve`): его операции проводятся сразу */
  canApprove: boolean;
  /** порог «Подтверждение владельцем от, $»; `null` — панель его не знает */
  thresholdUsd: number | null;
}

const IMMEDIATE: Outlook = { verdict: "immediate", text: "Проведётся сразу" };
const PENDING: Outlook = { verdict: "pending", text: "Ждёт подтверждения владельца" };

/**
 * Ждёт ли операция владельца — по правилу сервера (`needsApproval`, `approval.ts`): у владельца — сразу; исправление
 * финансов — всегда ждёт; нет оценки в долларах — ждёт; иначе от порога включительно. Пока оценки нет (черновик не
 * сохранён) или порог панели неизвестен, честно говорим «решит сервер»: угадывание вышло бы враньём в обе стороны.
 */
export function approvalOutlook(input: OutlookInput): Outlook {
  if (input.canApprove) return IMMEDIATE;
  if (input.kind === "reversal") return PENDING;
  if (input.amountUsd === undefined) {
    return { verdict: "unknown", text: "Проведётся сразу или уйдёт на подтверждение владельцу: решит порог в долларах по курсу, оценка появится после сохранения" };
  }
  if (input.amountUsd === null || !/^\d{1,18}(\.\d{1,18})?$/u.test(input.amountUsd)) return PENDING;
  if (input.thresholdUsd === null) {
    return { verdict: "unknown", text: `≈ ${input.amountUsd} $: крупные операции финансов ждут владельца — решит порог в настройках сервера` };
  }
  return Number(input.amountUsd) >= input.thresholdUsd ? PENDING : IMMEDIATE;
}

export const RECEIPT_WARNING = "Без чека НПД: налог периода не досчитается";

/** Зачисление в рубли без чека (Р221): отправить можно, но налоговая база периода будет неполной. */
export function receiptWarning(input: OperationInput, chart: Chart): string | null {
  if (input.kind !== "income" && input.kind !== "exchange") return null;
  const destination = chart.places.find((item) => item.accountId === input.to);
  return destination?.currency === "RUB" && input.receipt === undefined ? RECEIPT_WARNING : null;
}
