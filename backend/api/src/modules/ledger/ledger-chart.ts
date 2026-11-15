import { CURRENCIES, isCurrencyCode } from "@bh/fx";
import type { CurrencySpec } from "@bh/ledger";
import { DomainError } from "../../common/domain-error.js";

/**
 * Места хранения и статьи учёта (docs/37-accounting.md §3 и §6, Р220, tasks/T-0460): правила без базы —
 * идентификатор из названия, идентификатор счёта статьи в валюте, комиссия по шаблону места — и отказы, которые
 * видит тот, кто правит справочник. Таблицы и транзакции — `ledger-chart.repository.ts`, порядок действий —
 * `ledger-chart.service.ts`.
 */

/** Вид статьи: расход (счёт типа «расход») или поступление (счёт типа «выручка»). */
export type ArticleKind = "expense" | "income";

/** Вид валюты из справочника ядра курсов: от него зависит первый сегмент идентификатора места. */
export type CurrencyKind = "fiat" | "crypto" | "platform";

/** Слаг: латиница, цифры и дефисы, 3…48 знаков. Точки в нём нет — точка разделяет сегменты идентификатора счёта. */
export const SLUG_MIN = 3;
export const SLUG_MAX = 48;

/** Название места или статьи в базе — `VARCHAR(128)`. */
export const NAME_MAX = 128;

/** Название не превращается в идентификатор: короткое, длинное или без букв и цифр. Сообщение — по-русски. */
export class ChartRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartRuleError";
  }
}

// Транслитерация по привычному виду («Т-Банка» → «t-banka»): буква даёт латиницу, твёрдый и мягкий знаки — ничего.
const TRANSLIT: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Идентификатор из названия: строчные, кириллица транслитом, всё, что не буква и не цифра, — один дефис,
 * дефисов по краям нет. Слишком короткое и слишком длинное — исключение, а не обрезка: два длинных названия с
 * общим началом слиплись бы в один идентификатор.
 */
export function slugify(name: string): string {
  let slug = "";
  for (const char of name.toLowerCase()) {
    slug += TRANSLIT[char] ?? (/[a-z0-9]/u.test(char) ? char : "-");
  }
  slug = slug.replace(/-{2,}/gu, "-").replace(/^-|-$/gu, "");
  if (slug.length < SLUG_MIN) throw new ChartRuleError(`Из названия получается идентификатор короче ${String(SLUG_MIN)} знаков — нужно больше букв или цифр`);
  if (slug.length > SLUG_MAX) throw new ChartRuleError(`Название длинное: идентификатор из него длиннее ${String(SLUG_MAX)} знаков — нужно сократить`);
  return slug;
}

/** `expense.vps.USD`, `income.ads_adsgram.RUB`: одна статья принимает любую валюту — счёт заводится при первой проводке. */
export function articleAccountId(article: string, kind: ArticleKind, currency: string): string {
  return `${kind}.${article}.${currency}`;
}

/** Первый сегмент идентификатора места — как у мест на старте: `bank.rub`, `wallet.ton`, `stars.bot`. */
const PLACE_PREFIX: Readonly<Record<CurrencyKind, string>> = { fiat: "bank", crypto: "wallet", platform: "stars" };

export function placeAccountId(slug: string, kind: CurrencyKind): string {
  return `${PLACE_PREFIX[kind]}.${slug}`;
}

/** Шаблон комиссии места в базе: процент в сотых долях процента, фикса в минимальных единицах своей валюты. */
export interface FeeTemplate {
  percentBp: number | null;
  fixed: bigint | null;
  fixedCurrency: string | null;
}

export const FEE_PERCENT_BP_MAX = 10_000;

/** Что не так с шаблоном; `null` — всё в порядке. Те же правила держат CHECK базы, но человеку нужен текст. */
export function feeTemplateProblem(template: FeeTemplate): string | null {
  const { percentBp, fixed, fixedCurrency } = template;
  if (percentBp !== null && (!Number.isInteger(percentBp) || percentBp < 0 || percentBp > FEE_PERCENT_BP_MAX)) {
    return `Процент комиссии — от 0 до 100 (в сотых долях процента от 0 до ${String(FEE_PERCENT_BP_MAX)})`;
  }
  if ((fixed === null) !== (fixedCurrency === null)) return "Фикса комиссии задаётся вместе с её валютой";
  if (fixed !== null && fixed < 0n) return "Фикса комиссии не может быть отрицательной";
  if (fixedCurrency !== null && !isCurrencyCode(fixedCurrency)) return `Валюта фиксы «${fixedCurrency}» не входит в справочник валют`;
  return null;
}

/** Строка комиссии: процент — в валюте суммы, фикса — в своей. */
export interface FeeLine {
  kind: "percent" | "fixed";
  currency: string;
  /** минимальные единицы валюты строки */
  amount: bigint;
}

/**
 * Комиссия по шаблону от суммы в минимальных единицах валюты `spec`. Процент округляется вверх до единицы —
 * комиссию не занижаем; фикса — отдельной строкой в её валюте (вывод звёзд — процент в звёздах, сетевой сбор —
 * фикса в Gram). Без шаблона и с нулями — пусто. Шаблон в форме перевода правится руками, поэтому здесь это
 * только подсказка (docs/37-accounting.md §6).
 */
export function feeOf(amount: bigint, template: FeeTemplate, spec: CurrencySpec): FeeLine[] {
  if (amount <= 0n) throw new RangeError("Комиссию считают от положительной суммы");
  const lines: FeeLine[] = [];
  if (template.percentBp !== null && template.percentBp > 0) {
    const basis = BigInt(FEE_PERCENT_BP_MAX);
    const fee = (amount * BigInt(template.percentBp) + basis - 1n) / basis;
    lines.push({ kind: "percent", currency: spec.code, amount: fee });
  }
  if (template.fixed !== null && template.fixed > 0n && template.fixedCurrency !== null) {
    lines.push({ kind: "fixed", currency: template.fixedCurrency, amount: template.fixed });
  }
  return lines;
}

/** Вид валюты из справочника; код вне справочника — исключение, как у `currencySpec`. */
export function currencyKind(code: string): CurrencyKind {
  if (!isCurrencyCode(code)) throw new ChartRuleError(`Валюта «${code}» не входит в справочник валют`);
  return CURRENCIES[code].kind;
}

// ---- Виды для панели и входные данные сервиса ----

/** Шаблон на вход: фикса — десятичной строкой в единицах её валюты («0.05» Gram), как вводит человек. */
export interface FeeInput {
  percentBp?: number | null | undefined;
  fixed?: string | null | undefined;
  fixedCurrency?: string | null | undefined;
}

/** Шаблон на выход: фикса — десятичной строкой, как в журнале. */
export interface FeeView {
  percentBp: number | null;
  fixed: string | null;
  fixedCurrency: string | null;
}

export interface PlaceAccountView {
  accountId: string;
  name: string;
  /** остаток в единицах валюты места, десятичной строкой */
  balance: string;
}

/** Место хранения: счёт-актив в одной валюте или группа счетов (звёзды бота — холд и доступно). */
export interface PlaceView {
  placeId: string;
  name: string;
  currency: string;
  archived: boolean;
  /** сумма остатков счетов места */
  balance: string;
  fee: FeeView | null;
  accounts: PlaceAccountView[];
}

export interface ArticleView {
  articleId: string;
  kind: ArticleKind;
  name: string;
  system: boolean;
  archived: boolean;
}

export interface CreatePlaceInput {
  name: string;
  currency: string;
  fee?: FeeInput | undefined;
}

export interface UpdatePlaceInput {
  name?: string | undefined;
  /** `null` снимает шаблон */
  fee?: FeeInput | null | undefined;
}

export interface CreateArticleInput {
  name: string;
  kind: ArticleKind;
}

// ---- Отказы ----

/** Название или шаблон не годятся: текст — что исправить. */
export class LedgerChartInvalidError extends DomainError {
  constructor(reason: string) {
    super("ledger_chart_invalid", reason, 400);
  }
}

export class LedgerPlaceNotFoundError extends DomainError {
  constructor(placeId: string) {
    super("ledger_place_not_found", `Места хранения «${placeId}» нет`, 404);
  }
}

/** В месте лежат деньги: архив спрятал бы остаток из панели, а в отчётах он остался бы. */
export class LedgerPlaceNotEmptyError extends DomainError {
  constructor(placeId: string) {
    super("ledger_place_not_empty", `В месте «${placeId}» есть остаток — сначала нужно перевести его, потом архивировать`, 409);
  }
}

export class LedgerArticleNotFoundError extends DomainError {
  constructor(articleId: string) {
    super("ledger_article_not_found", `Статьи «${articleId}» нет`, 404);
  }
}

/** Служебная статья нужна проводкам самого учёта: комиссии, курсовая разница, налог. */
export class LedgerArticleSystemError extends DomainError {
  constructor(articleId: string) {
    super("ledger_article_system", `Статья «${articleId}» служебная — её не архивируют`, 409);
  }
}

export class LedgerArticleArchivedError extends DomainError {
  constructor(articleId: string) {
    super("ledger_article_archived", `Статья «${articleId}» в архиве — новых проводок по ней нет`, 409);
  }
}
