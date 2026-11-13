import { isCurrencyCode } from "@bh/fx";
import { formatMinor, toMinor, type EntryLine } from "@bh/ledger";
import { articleAccountId, type ArticleKind, type FeeTemplate } from "../ledger-chart.js";
import { currencySpec } from "../ledger-currencies.js";
import type { LedgerPostInput } from "../ledger.service.js";
import { EARLIEST_EVENT, type FeeBody, type OperationInput, type ReceiptInput } from "./operation-input.js";

/**
 * Сборщики проводок ручных операций (docs/37-accounting.md §4 и §6, Р220, Р221, tasks/T-0461): из того, что ввёл
 * человек, получается проводка двойной записи — или список проблем по-русски. Чистые функции: ничего не пишут и
 * в базу не ходят; справочник мест и статей и «сейчас» приходят аргументами. Баланс в каждой валюте проверяет
 * журнал (`findEntryProblems`) при записи, здесь строки составляются так, чтобы он сошёлся.
 */

/** Проблема операции: текст — что исправить, как есть показывается человеку. */
export interface BuildProblem {
  message: string;
}

/** Место хранения для сборщика: счёт-актив с группой и шаблоном комиссии. */
export interface ChartPlace {
  accountId: string;
  name: string;
  currency: string;
  /** группа места: у звёзд бота — «stars.bot» у обоих состояний */
  place: string;
  archived: boolean;
  fee: FeeTemplate;
}

export interface ChartArticle {
  articleId: string;
  name: string;
  kind: ArticleKind;
  archived: boolean;
}

/** Справочник учёта на момент сборки: места по идентификатору счёта и статьи по идентификатору. */
export interface OperationsChart {
  places: ReadonlyMap<string, ChartPlace>;
  articles: ReadonlyMap<string, ChartArticle>;
}

/** Счёт статьи в валюте: заводится перед проводкой (`LedgerChartService.ensureArticleAccount`). */
export interface ArticleAccountNeed {
  articleId: string;
  currency: string;
}

/** Служебный счёт, который заводит сам учёт: транзит обмена и обязательство по займу. */
export interface ServiceAccount {
  accountId: string;
  type: "asset" | "liability";
  currency: string;
  name: string;
}

/** Условия займа для строки `ledger_loan`; суммы — в минимальных единицах валюты займа. */
export interface BuiltLoan {
  lender: string;
  accountId: string;
  currency: string;
  principal: bigint;
  premium: bigint;
  repaymentBp: number;
}

/** Из чего оценивать операцию в долларах: по порядку, первая валюта с известным курсом. */
export interface EstimateBasis {
  currency: string;
  minor: bigint;
}

export interface BuiltOperation {
  draft: LedgerPostInput;
  articleAccounts: ArticleAccountNeed[];
  serviceAccounts: ServiceAccount[];
  loan: BuiltLoan | null;
  estimate: EstimateBasis[];
  receiptMissing: boolean;
}

export type BuildResult = { ok: true; built: BuiltOperation } | { ok: false; problems: BuildProblem[] };

/** Статьи служебных комиссий: у перевода — комиссия вывода, у обмена — комиссия обмена (docs/37 §3). */
const FEE_ARTICLE = { transfer: "fee_withdrawal", exchange: "fee_exchange" } as const;

/** Ключ проводки операции: повторное проведение той же операции — та же проводка. */
export function operationSourceKey(operationId: string): string {
  return `op:${operationId}`;
}

/** Транзитный счёт обмена в валюте: сюда «уходит» отданное и отсюда «приходит» полученное, поэтому каждая валюта сходится сама. */
export function transitAccountId(currency: string): string {
  return `exchange.transit.${currency}`;
}

/** Рублёвое зачисление требует чека НПД (Р221): налоговая база — чеки периода, а не вся выручка. */
const RECEIPT_CURRENCY = "RUB";

/**
 * Предел суммы — половина диапазона `bigint` базы: сумма с комиссией на одном счёте не переполнит строку журнала.
 * На деле это миллиарды единиц любой валюты, до чего проекту далеко.
 */
const MAX_MINOR = (1n << 62n) - 1n;

/** Строки проводки по счетам: два слагаемых одного счёта (процент и фикса с одного места) складываются, нули выпадают. */
class LineSet {
  private readonly sums = new Map<string, bigint>();

  add(accountId: string, amount: bigint): void {
    this.sums.set(accountId, (this.sums.get(accountId) ?? 0n) + amount);
  }

  lines(): EntryLine[] {
    return [...this.sums].filter(([, amount]) => amount !== 0n).map(([accountId, amount]) => ({ accountId, amount }));
  }
}

/** Дата события: настоящий день календаря. V8 молча превращает 31 февраля в 3 марта — для учёта это чужой месяц. */
export function parseAt(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(raw);
  const date = new Date(raw);
  if (match === null || Number.isNaN(date.getTime())) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const day0 = new Date(Date.UTC(year, month - 1, day));
  if (day0.getUTCFullYear() !== year || day0.getUTCMonth() !== month - 1 || day0.getUTCDate() !== day) return null;
  return date;
}

/** Дата события: не раньше начала учёта и не будущее. Дата проводки — `at`. */
export function commonProblems(input: OperationInput, now: Date): BuildProblem[] {
  const at = parseAt(input.at);
  if (at === null) return [{ message: `Дата «${input.at}» не существует` }];
  if (at.getTime() < EARLIEST_EVENT.getTime()) return [{ message: "Дата события раньше 1 января 2026 года: учёт начинается с этого дня" }];
  if (at.getTime() > now.getTime()) return [{ message: "Дата события в будущем: учёт записывает то, что уже случилось" }];
  return [];
}

type Mode = "positive" | "nonnegative";

/** Сумма из десятичной строки в минимальные единицы валюты; неверная — проблема, а не исключение. */
export function minorOf(raw: string, currency: string, label: string, problems: BuildProblem[], mode: Mode): bigint | null {
  if (!isCurrencyCode(currency)) {
    problems.push({ message: `${label}: валюта «${currency}» не входит в справочник валют` });
    return null;
  }
  let value: bigint;
  try {
    value = toMinor(raw, currencySpec(currency));
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof RangeError) {
      problems.push({ message: `${label}: ${error.message}` });
      return null;
    }
    throw error;
  }
  if (value < 0n || (value === 0n && mode === "positive")) {
    problems.push({ message: `${label}: сумма должна быть ${mode === "positive" ? "больше нуля" : "не меньше нуля"}` });
    return null;
  }
  if (value > MAX_MINOR) {
    problems.push({ message: `${label}: сумма слишком велика` });
    return null;
  }
  return value;
}

function placeOf(chart: OperationsChart, accountId: string, label: string, problems: BuildProblem[]): ChartPlace | null {
  const place = chart.places.get(accountId);
  if (place === undefined) {
    problems.push({ message: `${label}: места хранения «${accountId}» нет` });
    return null;
  }
  if (place.archived) {
    problems.push({ message: `${label}: место «${place.name}» в архиве — проводок по нему больше нет` });
    return null;
  }
  return place;
}

const KIND_NAME: Readonly<Record<ArticleKind, string>> = { expense: "расходов", income: "поступлений" };

function articleOf(chart: OperationsChart, articleId: string, kind: ArticleKind, problems: BuildProblem[]): ChartArticle | null {
  const article = chart.articles.get(articleId);
  if (article === undefined) {
    problems.push({ message: `Статьи «${articleId}» нет` });
    return null;
  }
  if (article.kind !== kind) {
    problems.push({ message: `Статья «${article.name}» — не из статей ${KIND_NAME[kind]}` });
    return null;
  }
  if (article.archived) {
    problems.push({ message: `Статья «${article.name}» в архиве — новых проводок по ней нет` });
    return null;
  }
  return article;
}

/** Кто и сколько платит комиссии: процент — с места списания, фикса — с места своей валюты. */
interface Charge {
  currency: string;
  amount: bigint;
  payer: ChartPlace;
}

/** Действующие места хранения в валюте: из них выбирается плательщик фиксы в чужой валюте. */
export function placesIn(chart: OperationsChart, currency: string): ChartPlace[] {
  return [...chart.places.values()].filter((place) => !place.archived && place.currency === currency);
}

/**
 * Место, с которого списывается фикса. Места одновалютные, поэтому фикса в чужой валюте — это другое место:
 * названное явно, а без названия — единственное место в этой валюте. Нет такого — «нет места в валюте фиксы»;
 * несколько — выбор за человеком: списать с угаданного значило бы тихо тронуть чужие деньги.
 */
function fixedPayer(fixed: NonNullable<FeeBody["fixed"]>, from: ChartPlace, chart: OperationsChart, problems: BuildProblem[]): ChartPlace | null {
  if (fixed.from !== undefined) {
    const place = placeOf(chart, fixed.from, "Фикса комиссии", problems);
    if (place !== null && place.currency !== fixed.currency) {
      problems.push({ message: `Фикса комиссии: место «${place.name}» — в валюте ${place.currency}, а фикса — в ${fixed.currency}` });
      return null;
    }
    return place;
  }
  if (fixed.currency === from.currency) return from;
  const candidates = placesIn(chart, fixed.currency);
  const [only] = candidates;
  if (only === undefined) {
    problems.push({ message: `Нет места в валюте фиксы ${fixed.currency}: комиссию не с чего списать — нужно завести место хранения в этой валюте` });
    return null;
  }
  if (candidates.length > 1) {
    problems.push({ message: `В валюте фиксы ${fixed.currency} несколько мест (${candidates.map((place) => `«${place.name}»`).join(", ")}) — нужно указать, с какого списать фиксу` });
    return null;
  }
  return only;
}

function chargesOf(fee: FeeBody | undefined, from: ChartPlace, chart: OperationsChart, problems: BuildProblem[]): Charge[] {
  if (fee === undefined) return [];
  const charges: Charge[] = [];
  if (fee.amount !== undefined) {
    const amount = minorOf(fee.amount, from.currency, "Комиссия", problems, "nonnegative");
    if (amount !== null && amount > 0n) charges.push({ currency: from.currency, amount, payer: from });
  }
  if (fee.fixed !== undefined) {
    const amount = minorOf(fee.fixed.amount, fee.fixed.currency, "Фикса комиссии", problems, "nonnegative");
    if (amount !== null && amount > 0n) {
      const payer = fixedPayer(fee.fixed, from, chart, problems);
      if (payer !== null) charges.push({ currency: fee.fixed.currency, amount, payer });
    }
  }
  return charges;
}

/** «2% + 0.05 GRAM» — шаблон комиссии места, как его видит человек (docs/37 §6). */
function templateText(template: FeeTemplate): string | null {
  const parts: string[] = [];
  if (template.percentBp !== null && template.percentBp > 0) parts.push(`${String(template.percentBp / 100)}%`);
  if (template.fixed !== null && template.fixed > 0n && template.fixedCurrency !== null && isCurrencyCode(template.fixedCurrency)) {
    parts.push(`${formatMinor(template.fixed, currencySpec(template.fixedCurrency))} ${template.fixedCurrency}`);
  }
  return parts.length === 0 ? null : parts.join(" + ");
}

/** Фактическая комиссия по валютам: «100 XTR + 0.05 GRAM». */
function chargesText(charges: readonly Charge[]): string | null {
  const byCurrency = new Map<string, bigint>();
  for (const charge of charges) byCurrency.set(charge.currency, (byCurrency.get(charge.currency) ?? 0n) + charge.amount);
  if (byCurrency.size === 0) return null;
  return [...byCurrency].map(([currency, amount]) => `${formatMinor(amount, currencySpec(currency))} ${currency}`).join(" + ");
}

/** Контекст сборки одной операции: накопленные проблемы, строки проводки и то, что нужно завести заранее. */
export class Assembly {
  readonly problems: BuildProblem[] = [];
  readonly lines = new LineSet();
  readonly articleNeeds = new Map<string, ArticleAccountNeed>();
  readonly serviceAccounts = new Map<string, ServiceAccount>();
  readonly meta: Record<string, string | number | boolean | null> = {};

  constructor(
    readonly operationId: string,
    readonly input: OperationInput,
    readonly chart: OperationsChart,
    now: Date,
  ) {
    this.problems.push(...commonProblems(input, now));
    this.meta.operation = operationId;
    this.meta.kind = input.kind;
    if (input.link !== undefined) this.meta.link = input.link;
  }

  /** Сумма из ввода; неверная пополняет проблемы и возвращает `null`. */
  amount(raw: string, currency: string, label: string, mode: Mode = "positive"): bigint | null {
    return minorOf(raw, currency, label, this.problems, mode);
  }

  place(accountId: string, label: string): ChartPlace | null {
    return placeOf(this.chart, accountId, label, this.problems);
  }

  article(articleId: string, kind: ArticleKind): ChartArticle | null {
    return articleOf(this.chart, articleId, kind, this.problems);
  }

  /** Строка счёта статьи в валюте: счёт заводится заранее. */
  articleLine(article: ChartArticle, currency: string, amount: bigint): void {
    this.lines.add(articleAccountId(article.articleId, article.kind, currency), amount);
    this.articleNeeds.set(`${article.articleId}|${currency}`, { articleId: article.articleId, currency });
  }

  /** Комиссии по месту списания: каждая — строка плательщика и строка статьи комиссии в валюте платежа. */
  fees(kind: "transfer" | "exchange", fee: FeeBody | undefined, from: ChartPlace): void {
    const charges = chargesOf(fee, from, this.chart, this.problems);
    const article = this.chart.articles.get(FEE_ARTICLE[kind]);
    if (charges.length > 0 && article === undefined) {
      this.problems.push({ message: `Статьи комиссии «${FEE_ARTICLE[kind]}» нет в справочнике: комиссию некуда отнести` });
      return;
    }
    for (const charge of charges) {
      this.lines.add(charge.payer.accountId, -charge.amount);
      if (article !== undefined) this.articleLine(article, charge.currency, charge.amount);
    }
    const template = templateText(from.fee);
    const actual = chargesText(charges);
    if (template !== null) this.meta.feeTemplate = template;
    if (actual !== null) this.meta.fee = actual;
  }

  transit(currency: string): string {
    const accountId = transitAccountId(currency);
    this.serviceAccounts.set(accountId, { accountId, type: "asset", currency, name: `Обмен (транзит), ${currency}` });
    return accountId;
  }

  /** Чек НПД у рублёвого зачисления: плательщик, номер и ссылка пишутся в проводку (Р221, docs/37 §12). */
  receipt(receipt: ReceiptInput | undefined, destination: ChartPlace | null): void {
    if (receipt === undefined || destination === null) return;
    if (destination.currency !== RECEIPT_CURRENCY) {
      this.problems.push({ message: `Чек НПД заводится при зачислении в рубли: у места «${destination.name}» валюта ${destination.currency}` });
      return;
    }
    this.meta.receiptPayer = receipt.payer;
    if (receipt.number !== undefined) this.meta.receiptNumber = receipt.number;
    if (receipt.link !== undefined) this.meta.receiptLink = receipt.link;
  }

  finish(built: { loan?: BuiltLoan; estimate: EstimateBasis[] }): BuildResult {
    if (this.problems.length > 0) return { ok: false, problems: this.problems };
    const at = parseAt(this.input.at);
    if (at === null) return { ok: false, problems: [{ message: `Дата «${this.input.at}» не существует` }] };
    return {
      ok: true,
      built: {
        draft: { sourceKey: operationSourceKey(this.operationId), at, memo: this.input.note, lines: this.lines.lines(), meta: this.meta },
        articleAccounts: [...this.articleNeeds.values()],
        serviceAccounts: [...this.serviceAccounts.values()],
        loan: built.loan ?? null,
        estimate: built.estimate,
        receiptMissing: receiptMissingOf(this.input, this.chart),
      },
    };
  }
}

/**
 * Нет чека НПД у зачисления в рубли (Р221): операция проводится и без него, но панель напоминает, а закрытие
 * месяца (волна 4) предупредит. Чек есть, если указан плательщик — номер, ссылку и картинку можно добавить позже.
 */
export function receiptMissingOf(input: OperationInput, chart: OperationsChart): boolean {
  if (input.kind !== "exchange" && input.kind !== "income") return false;
  return chart.places.get(input.to)?.currency === RECEIPT_CURRENCY && input.receipt === undefined;
}
