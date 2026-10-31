import { z } from "zod";
import { formatNumber, plural } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Фильтр имён в панели (docs/35-stage4-plan.md, Р168, tasks/T-0339): правила
 * по категориям, проверка на примерах и перечистка старых ников. Ручки правил —
 * `GET|POST /admin/name-rules`, `PATCH|DELETE /:ruleId`, `POST /test`; ручки
 * перечистки — `/admin/name-rules/reclean`. Ответы разбираются схемами: поле,
 * которого сервер не прислал, — ошибка, а не `undefined` в таблице.
 */

export const CATEGORY_ORDER = ["brand", "ads", "profanity", "other", "allow"] as const;
export type RuleCategory = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_TITLES: Record<RuleCategory, string> = {
  brand: "Бренды",
  ads: "Реклама и ссылки",
  profanity: "Мат",
  other: "Прочее",
  allow: "Исключения",
};

/** Что делается с совпадением — подпись у вкладки. */
export const CATEGORY_ACTIONS: Record<RuleCategory, string> = {
  brand: "вырезается из ника",
  ads: "вырезается из ника",
  other: "вырезается из ника",
  profanity: "ник заменяется целиком",
  allow: "не трогается",
};

export const RULE_KINDS = ["exact", "word", "regex"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const KIND_TITLES: Record<RuleKind, string> = { exact: "Точная фраза", word: "Слово целиком", regex: "Регулярное выражение" };
export const KIND_HINTS: Record<RuleKind, string> = { exact: "Ищет фразу где угодно в нике", word: "Не срабатывает внутри других слов", regex: "Для сложных случаев" };

const ruleSchema = z.object({
  ruleId: z.string(),
  category: z.enum(CATEGORY_ORDER),
  kind: z.enum(RULE_KINDS),
  pattern: z.string(),
  active: z.boolean(),
  note: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type NameRule = z.infer<typeof ruleSchema>;

const limitsSchema = z.object({ patternMax: z.number(), noteMax: z.number(), rulesMax: z.number(), samplesMax: z.number(), sampleMax: z.number() });
export type RuleLimits = z.infer<typeof limitsSchema>;

const rulesViewSchema = z.object({ rules: z.array(ruleSchema), limits: limitsSchema });
export type RulesView = z.infer<typeof rulesViewSchema>;

const probeResultSchema = z.object({
  sample: z.string(),
  name: z.string().nullable(),
  verdict: z.enum(["ok", "trimmed", "symbols", "empty", "profanity"]),
  candidateHit: z.boolean(),
  saved: z.boolean(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const recleanStateSchema = z.object({
  runId: z.string(),
  mode: z.enum(["preview", "run"]),
  status: z.enum(["queued", "running", "done", "failed", "stopped"]),
  signature: z.string(),
  scanned: z.number(),
  planned: z.number(),
  updated: z.number(),
  skipped: z.number(),
  locked: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  startedBy: z.string(),
  error: z.string().nullable(),
});
export type RecleanState = z.infer<typeof recleanStateSchema>;

export interface RuleBody {
  category: RuleCategory;
  kind: RuleKind;
  pattern: string;
  note?: string | null;
  active?: boolean;
}

export interface ProbeBody {
  ruleId?: string;
  category: RuleCategory;
  kind: RuleKind;
  pattern: string;
  samples: string[];
}

const ROOT = "/name-rules";

export function fetchRules(api: AdminApi): Promise<ApiResult<RulesView>> {
  return api.request(ROOT, { schema: rulesViewSchema });
}

export function createRule(api: AdminApi, body: RuleBody): Promise<ApiResult<NameRule>> {
  return api.request(ROOT, { method: "POST", body, schema: ruleSchema });
}

export function updateRule(api: AdminApi, ruleId: string, patch: Partial<RuleBody>): Promise<ApiResult<NameRule>> {
  return api.request(`${ROOT}/${encodeURIComponent(ruleId)}`, { method: "PATCH", body: patch, schema: ruleSchema });
}

export function removeRule(api: AdminApi, ruleId: string): Promise<ApiResult<{ removed: true }>> {
  return api.request(`${ROOT}/${encodeURIComponent(ruleId)}`, { method: "DELETE", schema: z.object({ removed: z.literal(true) }) });
}

/** Проверка на примерах: правило не сохраняется. */
export async function probeRule(api: AdminApi, body: ProbeBody): Promise<ApiResult<ProbeResult[]>> {
  const result = await api.request(`${ROOT}/test`, { method: "POST", body, schema: z.object({ results: z.array(probeResultSchema) }) });
  return result.ok ? { ok: true, data: result.data.results } : result;
}

export function fetchReclean(api: AdminApi): Promise<ApiResult<RecleanState | null>> {
  return api.request(`${ROOT}/reclean`, { schema: recleanStateSchema.nullable() });
}

export function startPreview(api: AdminApi): Promise<ApiResult<RecleanState>> {
  return api.request(`${ROOT}/reclean/preview`, { method: "POST", schema: recleanStateSchema });
}

export function startRun(api: AdminApi, previewRunId: string): Promise<ApiResult<RecleanState>> {
  return api.request(`${ROOT}/reclean/run`, { method: "POST", body: { previewRunId }, schema: recleanStateSchema });
}

export function stopReclean(api: AdminApi): Promise<ApiResult<RecleanState | null>> {
  return api.request(`${ROOT}/reclean/stop`, { method: "POST", schema: recleanStateSchema.nullable() });
}

export interface RuleForm {
  category: RuleCategory;
  kind: RuleKind;
  pattern: string;
  note: string;
  active: boolean;
}

/** Форма правила: пределы берутся у сервера, тексты ошибок — наши. */
export function ruleFormSchema(limits: RuleLimits) {
  return z.object({
    category: z.enum(CATEGORY_ORDER),
    kind: z.enum(RULE_KINDS),
    pattern: z
      .string()
      .trim()
      .min(1, "Введите слово или фразу")
      .max(limits.patternMax, `Не длиннее ${String(limits.patternMax)} знаков`),
    note: z.string().max(limits.noteMax, `Не длиннее ${String(limits.noteMax)} знаков`),
    active: z.boolean(),
  });
}

export function ruleBodyOf(form: RuleForm): RuleBody {
  const note = form.note.trim();
  return { category: form.category, kind: form.kind, pattern: form.pattern.trim(), note: note === "" ? null : note, active: form.active };
}

/** Правила вкладки: включённые выше выключенных, внутри — по шаблону без учёта регистра. */
export function rulesOf(view: RulesView, category: RuleCategory): NameRule[] {
  return view.rules
    .filter((rule) => rule.category === category)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.pattern.localeCompare(b.pattern, "ru", { sensitivity: "base" }));
}

export function categoryCounts(view: RulesView): Record<RuleCategory, number> {
  const counts: Record<RuleCategory, number> = { brand: 0, ads: 0, profanity: 0, other: 0, allow: 0 };
  for (const rule of view.rules) counts[rule.category] += 1;
  return counts;
}

/** Что станет с ником, если правило записать. */
export function verdictText(result: ProbeResult): string {
  if (result.verdict === "ok") return "ник не изменится";
  if (result.verdict === "profanity") return "ник будет заменён";
  if (result.verdict === "empty" || result.name === null) return "ника не останется";
  return `останется: ${result.name}`;
}

const PLAYERS: readonly [string, string, string] = ["игрок", "игрока", "игроков"];

/** Строка состояния перечистки над кнопками. */
export function recleanLine(state: RecleanState | null): string {
  if (state === null) return "Перечистка ещё не запускалась";
  if (state.status === "failed") return state.error ?? "Перечистка прервалась";
  if (state.status === "stopped") return `Остановлено: изменено ${formatNumber(state.updated)} из ${formatNumber(state.planned)}`;
  const running = state.status === "queued" || state.status === "running";
  if (state.mode === "preview") {
    return running
      ? `Считаем: проверено ${formatNumber(state.scanned)}, затронет ${formatNumber(state.planned)}`
      : `Затронет ${formatNumber(state.planned)} ${plural(state.planned, PLAYERS)} из ${formatNumber(state.scanned)} проверенных (закреплённых: ${formatNumber(state.locked)})`;
  }
  return running
    ? `Перечищаем: проверено ${formatNumber(state.scanned)}, изменено ${formatNumber(state.updated)}`
    : `Готово: изменено ${formatNumber(state.updated)}, пропущено ${formatNumber(state.skipped)} — игрок успел зайти`;
}

/** Предпросмотр годен час: так же, как на сервере (`RECLEAN_PREVIEW_TTL_MS`). */
export const PREVIEW_TTL_MS = 3_600_000;

/** Идёт ли проход прямо сейчас — по этому экран опрашивает сервер. */
export function recleanActive(state: RecleanState | null): boolean {
  return state !== null && (state.status === "queued" || state.status === "running");
}

/**
 * «Перечистить» доступна только после свежего готового предпросмотра, пока
 * правила не менялись. Сервер проверяет подпись правил сам; здесь — чтобы кнопка
 * не звала заведомый отказ.
 */
export function canRun(state: RecleanState | null, rulesChanged: boolean, now: Date): boolean {
  if (state === null || state.mode !== "preview" || state.status !== "done" || state.finishedAt === null) return false;
  if (now.getTime() - Date.parse(state.finishedAt) > PREVIEW_TTL_MS) return false;
  return !rulesChanged;
}

/** Правила менялись после предпросмотра: самое свежее `updatedAt` позже его конца. */
export function rulesChangedAfter(view: RulesView, state: RecleanState | null): boolean {
  if (state === null || state.finishedAt === null) return false;
  const finished = Date.parse(state.finishedAt);
  return view.rules.some((rule) => Date.parse(rule.updatedAt) > finished);
}
