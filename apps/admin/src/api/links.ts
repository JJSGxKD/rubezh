import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { formatDateTime, formatTime } from "../format";

/**
 * Ссылки кампаний (`/admin/links`, docs/24-attribution-and-sharing.md §3) и
 * конверсии закупок, ушедшие по ним в рекламную сеть (WP43, Р86).
 */

/** Сети, куда умеем отдавать конверсии; сервер знает тот же список (`link-networks.ts`). */
export const LINK_NETWORKS = ["adsgram"] as const;
export type LinkNetwork = (typeof LINK_NETWORKS)[number];

export const NETWORK_TITLES: Record<LinkNetwork, string> = { adsgram: "AdsGram" };

export type RegistrationOn = "first_run" | "launch";

const goalCountsSchema = z.object({ pending: z.number(), sent: z.number(), failed: z.number(), skipped: z.number() });
const summarySchema = z.object({ "1": goalCountsSchema, "2": goalCountsSchema, "3": goalCountsSchema });

export type GoalCounts = z.infer<typeof goalCountsSchema>;
export type ConversionSummary = z.infer<typeof summarySchema>;

export const linkSchema = z.object({
  code: z.string(),
  url: z.string(),
  platform: z.string(),
  campaign: z.string(),
  source: z.string().nullable(),
  medium: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  // Сеть, о которой панель ещё не знает, показывается обычной ссылкой, а не ломает список.
  network: z.enum(LINK_NETWORKS).nullable().catch(null),
  registrationOn: z.enum(["first_run", "launch"]).catch("first_run"),
  /** адрес с макросами сети — его вставляют в кабинет сети; у обычной ссылки `null` */
  networkUrl: z.string().nullable(),
});

export const linkStatsSchema = linkSchema.extend({
  clicks: z.number(),
  clicks30d: z.number(),
  launches: z.number(),
  conversions: summarySchema.nullable(),
});

export type Link = z.infer<typeof linkSchema>;
export type LinkRow = z.infer<typeof linkStatsSchema>;

const linksResponseSchema = z.object({
  links: z.array(linkStatsSchema),
  /** задан ли токен нашего кабинета сети — без значения */
  postback: z.object({ adsgramToken: z.boolean() }),
});

export type LinksResponse = z.infer<typeof linksResponseSchema>;

export interface NewLink {
  campaign: string;
  source?: string;
  medium?: string;
  note?: string;
  network?: LinkNetwork;
  registrationOn?: RegistrationOn;
}

/** Тот же формат, что проверяет сервер: кампания и источник уходят в разрезы аналитики. */
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function fetchLinks(api: AdminApi): Promise<ApiResult<LinksResponse>> {
  return api.request("/links", { schema: linksResponseSchema });
}

export function createLink(api: AdminApi, input: NewLink): Promise<ApiResult<Link>> {
  return api.request("/links", { method: "POST", body: input, schema: linkSchema });
}

/** Только что заведённая ссылка строкой списка — карточка открывается, не дожидаясь перечитывания. */
export function freshRow(link: Link): LinkRow {
  const counts = (): GoalCounts => ({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  return { ...link, clicks: 0, clicks30d: 0, launches: 0, conversions: link.network === null ? null : { "1": counts(), "2": counts(), "3": counts() } };
}

/** Доля запусков от кликов, целыми процентами; без кликов — `null`. */
export function conversion(row: Pick<LinkRow, "clicks" | "launches">): number | null {
  return row.clicks === 0 ? null : Math.round((row.launches / row.clicks) * 100);
}

// --- Конверсии сети ---

export type ConversionGoal = 1 | 2 | 3;

export const GOALS: readonly ConversionGoal[] = [1, 2, 3];

export const GOAL_TITLES: Record<ConversionGoal, string> = { 1: "Регистрация", 2: "Первая покупка", 3: "Повторная покупка" };

export const conversionSchema = z.object({
  conversionId: z.string(),
  goal: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  status: z.enum(["pending", "sent", "failed", "skipped"]),
  reason: z.string().nullable(),
  attempts: z.number(),
  httpStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  accountId: z.string(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  nextAttemptAt: z.string(),
});

export type Conversion = z.infer<typeof conversionSchema>;

const journalSchema = z.object({ conversions: z.array(conversionSchema), next: z.string().nullable() });

export function fetchConversions(api: AdminApi, code: string, before: string | null): Promise<ApiResult<z.infer<typeof journalSchema>>> {
  const query = before === null ? "" : `?before=${encodeURIComponent(before)}`;
  return api.request(`/links/${encodeURIComponent(code)}/conversions${query}`, { schema: journalSchema });
}

/** Отправить снова — неотправленную или пропущенную: уйдёт ближайшим проходом, в течение минуты. */
export function resendConversion(api: AdminApi, code: string, conversionId: string): Promise<ApiResult<Conversion>> {
  return api.request(`/links/${encodeURIComponent(code)}/conversions/${encodeURIComponent(conversionId)}/send`, { method: "POST", schema: conversionSchema });
}

/** Что с конверсией — словами для журнала: заголовок, тон значка и подробность. */
export interface ConversionState {
  title: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  detail: string;
  /** можно отправить снова руками */
  resendable: boolean;
}

const SKIP_REASONS: Record<string, string> = {
  team: "аккаунт команды: свои проверки сети ни к чему. Проверяете связку с кабинетом — отправьте руками",
  no_macros: "в клике нет меток сети — переход не из рекламы: превью кабинета или проверка ссылки руками",
  unknown_network: "сеть ссылки больше не поддерживается",
};

export function conversionState(row: Conversion): ConversionState {
  switch (row.status) {
    case "sent":
      return { title: "Ушла", tone: "success", detail: `${formatDateTime(row.sentAt)}${row.httpStatus === null ? "" : `, ответ ${String(row.httpStatus)}`}`, resendable: false };
    case "failed":
      return {
        title: "Не ушла",
        tone: "danger",
        detail: `${row.lastError ?? "сеть отказала"}${row.attempts > 1 ? ` — попыток: ${String(row.attempts)}` : ""}`,
        resendable: true,
      };
    case "skipped":
      // Отправить руками можно только аккаунт команды: без меток сети повтор пропустился бы снова.
      return { title: "Пропущена", tone: "neutral", detail: (row.reason === null ? undefined : SKIP_REASONS[row.reason]) ?? row.reason ?? "", resendable: row.reason === "team" };
    case "pending":
      if (row.reason === "no_token") return { title: "Ждёт токен", tone: "warning", detail: "токен конверсий не задан — уйдёт в течение пяти минут после того, как его зададут", resendable: false };
      if (row.attempts > 0) {
        return { title: "Повтор", tone: "warning", detail: `${row.lastError ?? "сбой сети"}; следующая попытка в ${formatTime(row.nextAttemptAt)}`, resendable: false };
      }
      return { title: "В очереди", tone: "info", detail: "уйдёт в течение минуты", resendable: false };
  }
}

const GOAL_KEYS = { 1: "1", 2: "2", 3: "3" } as const;

export function goalCounts(summary: ConversionSummary, goal: ConversionGoal): GoalCounts {
  return summary[GOAL_KEYS[goal]];
}

/** Итог по ссылке для списка: сколько отдано сети и есть ли что чинить. */
export interface SummaryLine {
  registrations: number;
  purchases: number;
  failed: number;
  waiting: number;
}

export function summaryLine(summary: ConversionSummary): SummaryLine {
  // Пропущенные — не конверсии сети: аккаунты команды и переходы не из рекламы.
  const counted = (counts: GoalCounts) => counts.sent + counts.pending + counts.failed;
  return {
    registrations: counted(goalCounts(summary, 1)),
    purchases: counted(goalCounts(summary, 2)) + counted(goalCounts(summary, 3)),
    failed: GOALS.reduce((sum, goal) => sum + goalCounts(summary, goal).failed, 0),
    waiting: GOALS.reduce((sum, goal) => sum + goalCounts(summary, goal).pending, 0),
  };
}
