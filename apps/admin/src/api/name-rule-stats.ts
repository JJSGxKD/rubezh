import { z } from "zod";
import { formatNumber } from "../format";
import type { AdminApi, ApiResult } from "./client";
import type { NameRule } from "./name-rules";

/**
 * Статистика срабатываний правил фильтра имён в панели (docs/35-stage4-plan.md,
 * Р168, tasks/T-0340): `GET /admin/name-rules/stats?days=7|30|90`. Ответ
 * разбирается схемой; чистые функции — топ, «не срабатывали», подписи и
 * сортировка списка — для блока «Что срабатывает». Ников и идентификаторов
 * игроков в ответе нет: только правило, сутки и число.
 */

export const STATS_WINDOWS = [7, 30, 90] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];
export const DEFAULT_WINDOW: StatsWindow = 30;

export const WINDOW_TITLES: Record<StatsWindow, string> = { 7: "7 суток", 30: "30 суток", 90: "90 суток" };

export const statsViewSchema = z.object({
  days: z.number(),
  since: z.string(),
  trackedSince: z.string().nullable(),
  totalHits: z.number(),
  rules: z.array(z.object({ ruleId: z.string(), hits: z.number(), lastDay: z.string().nullable() })),
});
export type NameRuleStats = z.infer<typeof statsViewSchema>;

export function fetchStats(api: AdminApi, days: number): Promise<ApiResult<NameRuleStats>> {
  return api.request(`/name-rules/stats?days=${String(days)}`, { schema: statsViewSchema });
}

export interface RuleStat {
  hits: number;
  lastDay: string | null;
}

const NO_HITS: RuleStat = { hits: 0, lastDay: null };

/** Правило → число за окно и последний день. Правила, которых в ответе нет, — не «ноль» здесь, а `undefined`. */
export function statsById(stats: NameRuleStats): Map<string, RuleStat> {
  return new Map(stats.rules.map((rule) => [rule.ruleId, { hits: rule.hits, lastDay: rule.lastDay }]));
}

/** Правила с срабатываниями за окно, по убыванию, при равенстве — по шаблону. */
export function topRules(rules: readonly NameRule[], stats: NameRuleStats, limit = 5): { rule: NameRule; hits: number }[] {
  const byId = statsById(stats);
  return rules
    .map((rule) => ({ rule, hits: byId.get(rule.ruleId)?.hits ?? 0 }))
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits || left.rule.pattern.localeCompare(right.rule.pattern, "ru"))
    .slice(0, limit);
}

/** Действующие правила, которые за окно не срабатывали; выключенные «лишними» не считаются. */
export function unusedRules(rules: readonly NameRule[], stats: NameRuleStats): NameRule[] {
  const byId = statsById(stats);
  return rules.filter((rule) => rule.active && (byId.get(rule.ruleId)?.hits ?? 0) === 0);
}

const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

function dayStart(text: string): number {
  return Date.parse(`${text}T00:00:00Z`);
}

/** Дата суток без времени: «12 окт.» — по UTC, как считает сервер. */
function dayText(text: string): string {
  return dayFormat.format(new Date(dayStart(text)));
}

/** «сегодня», «вчера», «12 окт.», `—` если правило не срабатывало. Сутки — по UTC. */
export function lastHitText(lastDay: string | null, today: Date): string {
  if (lastDay === null) return "—";
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((now - dayStart(lastDay)) / DAY_MS);
  if (days === 0) return "сегодня";
  if (days === 1) return "вчера";
  return dayText(lastDay);
}

/** Оговорка, если окно длиннее учёта: раньше срабатывания не считались; `null` — окно целиком покрыто. */
export function trackedNote(stats: NameRuleStats, today: Date): string | null {
  // Данных ещё нет вовсе — учёт идёт с сегодняшних суток.
  const tracked = stats.trackedSince ?? today.toISOString().slice(0, 10);
  if (stats.trackedSince !== null && tracked <= stats.since) return null;
  return `Учёт ведётся с ${dayText(tracked)}: раньше срабатывания не считались`;
}

export type RuleSort = "recent" | "most" | "least";

export const RULE_SORTS: readonly { value: RuleSort; title: string }[] = [
  { value: "recent", title: "Недавно изменённые" },
  { value: "most", title: "Чаще срабатывают" },
  { value: "least", title: "Реже срабатывают" },
];

/** Порядок списка; стабильно: равные остаются в исходном порядке. Без статистики частота не различает правил. */
export function sortRules(rules: readonly NameRule[], stats: NameRuleStats | null, sort: RuleSort): NameRule[] {
  const byId = stats === null ? new Map<string, RuleStat>() : statsById(stats);
  const hits = (rule: NameRule): number => (byId.get(rule.ruleId) ?? NO_HITS).hits;
  const ordered = rules.map((rule, index) => ({ rule, index }));
  ordered.sort((left, right) => {
    if (sort === "recent") return Date.parse(right.rule.updatedAt) - Date.parse(left.rule.updatedAt) || left.index - right.index;
    const difference = sort === "most" ? hits(right.rule) - hits(left.rule) : hits(left.rule) - hits(right.rule);
    return difference || left.index - right.index;
  });
  return ordered.map((item) => item.rule);
}

/** Строка топа: «пример-бренд — 1 234». */
export function topLine(item: { rule: NameRule; hits: number }): string {
  return `${item.rule.pattern} — ${formatNumber(item.hits)}`;
}
