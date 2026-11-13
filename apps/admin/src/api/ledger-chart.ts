import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { formatAmount } from "./ledger";

/**
 * Места хранения, статьи и шаблоны расходов (`/admin/ledger/places|articles|templates`, Р220, tasks/T-0460 и
 * T-0463, tasks/T-0465). Суммы приходят строками в единицах валюты; число из них не делается нигде, кроме подписи.
 */

const feeSchema = z.object({ percentBp: z.number().nullable(), fixed: z.string().nullable(), fixedCurrency: z.string().nullable() });

const placeSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  currency: z.string(),
  archived: z.boolean(),
  balance: z.string(),
  fee: feeSchema.nullable(),
  accounts: z.array(z.object({ accountId: z.string(), name: z.string(), balance: z.string() })),
});

const articleSchema = z.object({ articleId: z.string(), kind: z.enum(["expense", "income"]), name: z.string(), system: z.boolean(), archived: z.boolean() });

const templateSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  articleId: z.string(),
  articleName: z.string(),
  placeAccountId: z.string(),
  placeName: z.string(),
  currency: z.string(),
  amount: z.string(),
  schedule: z.enum(["monthly", "yearly"]),
  month: z.number().nullable(),
  note: z.string().nullable(),
  archived: z.boolean(),
});

export const placesSchema = z.object({ places: z.array(placeSchema) });
export const articlesSchema = z.object({ articles: z.array(articleSchema) });
export const templatesSchema = z.object({ templates: z.array(templateSchema) });
const okSchema = z.object({ ok: z.literal(true) });
const draftSchema = z.object({
  period: z.string(),
  created: z.number(),
  existing: z.number(),
  failed: z.array(z.object({ templateId: z.string(), name: z.string(), reason: z.string() })),
});

export type Fee = z.infer<typeof feeSchema>;
export type Place = z.infer<typeof placeSchema>;
export type Article = z.infer<typeof articleSchema>;
export type Template = z.infer<typeof templateSchema>;
export type TemplateSchedule = Template["schedule"];
export type DraftResult = z.infer<typeof draftSchema>;

/** Валюты справочника ядра курсов: сервер отвергает прочие, отдельного списка по HTTP у него нет. */
export const PLACE_CURRENCIES = ["RUB", "USD", "EUR", "USDT", "GRAM", "XTR"] as const;

export const NAME_MAX = 128;
export const NOTE_MAX = 500;

// ——— подписи ———

const CURRENCY_TITLES: Readonly<Record<string, string>> = { GRAM: "Gram" };

/** Хвост нулей после точки не нужен ни в подписи, ни в поле формы. */
function trimZeros(amount: string): string {
  return amount.includes(".") ? amount.replace(/0+$/u, "").replace(/\.$/u, "") : amount;
}

/** «0.050000000», «GRAM» → «0,05 Gram»; «50.00», «RUB» → «50 ₽». */
function feeFixedLabel(fixed: string, currency: string | null): string {
  const trimmed = trimZeros(fixed);
  if (currency === null) return trimmed.replace(".", ",");
  const title = CURRENCY_TITLES[currency];
  if (title !== undefined) return `${trimmed.replace(".", ",")} ${title}`;
  return formatAmount(trimmed, currency);
}

/** Сумма сервера в поле формы: «1500.00» → «1500», «0.05» → «0,05». */
export function amountToForm(amount: string): string {
  return trimZeros(amount).replace(".", ",");
}

/** Сотые доли процента → «2,5». */
export function bpToPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  if (fraction === 0) return String(whole);
  const text = String(fraction).padStart(2, "0").replace(/0$/u, "");
  return `${String(whole)},${text}`;
}

/** Шаблон комиссии человеческим языком: «2 %», «0,05 Gram», «2 % + 0,05 Gram», «без комиссии». */
export function feeLabel(fee: Fee | null): string {
  if (fee === null) return "без комиссии";
  const parts: string[] = [];
  if (fee.percentBp !== null && fee.percentBp > 0) parts.push(`${bpToPercent(fee.percentBp)} %`);
  if (fee.fixed !== null && Number(fee.fixed) > 0) parts.push(feeFixedLabel(fee.fixed, fee.fixedCurrency));
  return parts.length === 0 ? "без комиссии" : parts.join(" + ");
}

export const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** График шаблона: «каждый месяц», «каждый март». */
export function scheduleLabel(schedule: TemplateSchedule, month: number | null): string {
  if (schedule === "monthly") return "каждый месяц";
  const name = month === null ? undefined : MONTH_NAMES[month - 1];
  return name === undefined ? "раз в год" : `каждый ${name}`;
}

/** Статьи двумя списками; архивные не показываются. */
export function articleGroups(articles: readonly Article[]): { expense: Article[]; income: Article[] } {
  const live = articles.filter((article) => !article.archived);
  return { expense: live.filter((article) => article.kind === "expense"), income: live.filter((article) => article.kind === "income") };
}

// ——— разбор ввода формы ———

/** Процент «2,5» → сотые доли процента; пусто — `null`, мусор и выход за 0…100 — `"invalid"`. */
export function percentToBp(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(trimmed)) return "invalid";
  const bp = Math.round(Number(trimmed) * 100);
  return bp > 10_000 ? "invalid" : bp;
}

/** Десятичная сумма из формы: запятая → точка; пусто — `null`, мусор — `"invalid"`. */
export function amountToText(text: string): string | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  return /^\d{1,18}(\.\d{1,18})?$/u.test(trimmed) ? trimmed : "invalid";
}

export interface FeeForm {
  percent: string;
  fixed: string;
  fixedCurrency: string;
}

export type FeeParse = { ok: true; fee: Fee | null } | { ok: false; problem: string };

/** Форма комиссии → тело запроса; обе половины пусты — комиссии нет. */
export function feeToInput(form: FeeForm): FeeParse {
  const percentBp = percentToBp(form.percent);
  if (percentBp === "invalid") return { ok: false, problem: "Процент — от 0 до 100, не больше двух знаков после запятой" };
  const fixed = amountToText(form.fixed);
  if (fixed === "invalid") return { ok: false, problem: "Фикса — неотрицательное число" };
  if (percentBp === null && fixed === null) return { ok: true, fee: null };
  return { ok: true, fee: { percentBp, fixed, fixedCurrency: fixed === null ? null : form.fixedCurrency } };
}

export function feeToForm(fee: Fee | null, placeCurrency: string): FeeForm {
  return {
    percent: fee?.percentBp == null || fee.percentBp === 0 ? "" : bpToPercent(fee.percentBp),
    fixed: fee?.fixed == null ? "" : trimZeros(fee.fixed).replace(".", ","),
    fixedCurrency: fee?.fixedCurrency ?? placeCurrency,
  };
}

// ——— вызовы ———

export function loadPlaces(api: AdminApi): Promise<ApiResult<z.infer<typeof placesSchema>>> {
  return api.request("/ledger/places", { schema: placesSchema });
}

export function loadArticles(api: AdminApi): Promise<ApiResult<z.infer<typeof articlesSchema>>> {
  return api.request("/ledger/articles", { schema: articlesSchema });
}

export function loadTemplates(api: AdminApi): Promise<ApiResult<z.infer<typeof templatesSchema>>> {
  return api.request("/ledger/templates", { schema: templatesSchema });
}

export function createPlace(api: AdminApi, body: { name: string; currency: string; fee?: Fee }): Promise<ApiResult<{ place: Place }>> {
  return api.request("/ledger/places", { method: "POST", body, schema: z.object({ place: placeSchema }) });
}

export function updatePlace(api: AdminApi, id: string, body: { name?: string; fee?: Fee | null }): Promise<ApiResult<{ place: Place }>> {
  return api.request(`/ledger/places/${encodeURIComponent(id)}`, { method: "PATCH", body, schema: z.object({ place: placeSchema }) });
}

export function archivePlace(api: AdminApi, id: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`/ledger/places/${encodeURIComponent(id)}/archive`, { method: "POST", schema: okSchema });
}

export function createArticle(api: AdminApi, body: { name: string; kind: "expense" | "income" }): Promise<ApiResult<{ article: Article }>> {
  return api.request("/ledger/articles", { method: "POST", body, schema: z.object({ article: articleSchema }) });
}

export function renameArticle(api: AdminApi, id: string, name: string): Promise<ApiResult<{ article: Article }>> {
  return api.request(`/ledger/articles/${encodeURIComponent(id)}`, { method: "PATCH", body: { name }, schema: z.object({ article: articleSchema }) });
}

export function archiveArticle(api: AdminApi, id: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`/ledger/articles/${encodeURIComponent(id)}/archive`, { method: "POST", schema: okSchema });
}

export interface TemplateBody {
  name: string;
  articleId: string;
  placeAccountId: string;
  amount: string;
  schedule: TemplateSchedule;
  month: number | null;
  note: string | null;
}

export function createTemplate(api: AdminApi, body: TemplateBody): Promise<ApiResult<{ template: Template }>> {
  const { month, note, ...rest } = body;
  const payload = { ...rest, ...(month === null ? {} : { month }), ...(note === null ? {} : { note }) };
  return api.request("/ledger/templates", { method: "POST", body: payload, schema: z.object({ template: templateSchema }) });
}

export function updateTemplate(api: AdminApi, id: string, body: TemplateBody): Promise<ApiResult<{ template: Template }>> {
  return api.request(`/ledger/templates/${encodeURIComponent(id)}`, { method: "PATCH", body, schema: z.object({ template: templateSchema }) });
}

export function archiveTemplate(api: AdminApi, id: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`/ledger/templates/${encodeURIComponent(id)}/archive`, { method: "POST", schema: okSchema });
}

/** «Расходы месяца»: черновики операций по шаблонам периода («ГГГГ-ММ»). */
export function draftPeriod(api: AdminApi, period: string): Promise<ApiResult<DraftResult>> {
  return api.request("/ledger/templates/draft-period", { method: "POST", body: { period }, schema: draftSchema });
}

/** Текущий месяц «ГГГГ-ММ» по UTC — как считает сервер. */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Итог «Расходов месяца» словами. */
export function draftSummary(result: DraftResult): string {
  const parts = [`создано черновиков: ${String(result.created)}`];
  if (result.existing > 0) parts.push(`уже были: ${String(result.existing)}`);
  if (result.failed.length > 0) parts.push(`не удалось: ${result.failed.map((failure) => `${failure.name} — ${failure.reason}`).join("; ")}`);
  return parts.join(", ");
}
