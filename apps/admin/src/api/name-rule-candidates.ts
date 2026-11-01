import { z } from "zod";
import { formatDateTime } from "../format";
import type { AdminApi, ApiResult } from "./client";
import { CATEGORY_ORDER, RULE_KINDS, type RuleCategory } from "./name-rules";

/**
 * Кандидаты в правила фильтра имён (Р168, tasks/T-0341): слова и пары слов из
 * ночного расчёта — `GET /admin/name-rules/candidates`, «в правила» —
 * `POST /:candidateId/accept`, «не нужно» — `POST /:candidateId/dismiss`.
 * Сервер хранит и отдаёт только слово и число игроков; ответы разбираются
 * схемами: поле, которого сервер не прислал, — ошибка, а не пустая таблица.
 */

export const CANDIDATE_KINDS = ["word", "pair"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

const candidateSchema = z.object({
  candidateId: z.string(),
  token: z.string(),
  kind: z.enum(CANDIDATE_KINDS),
  players: z.number(),
  firstSeenAt: z.string(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const candidatesViewSchema = z.object({
  computedAt: z.string().nullable(),
  minPlayers: z.number(),
  windowDays: z.number(),
  items: z.array(candidateSchema),
});
export type CandidatesView = z.infer<typeof candidatesViewSchema>;

/** Как искать слово из расчёта: регулярку по нему не заводим. */
export type AcceptKind = Extract<(typeof RULE_KINDS)[number], "exact" | "word">;

export interface AcceptBody {
  category: RuleCategory;
  kind: AcceptKind;
}

/** Правило, созданное из кандидата: панели нужно знать, что оно появилось, а не все его поля. */
const acceptedSchema = z.object({ ruleId: z.string(), category: z.enum(CATEGORY_ORDER), pattern: z.string() });

const ROOT = "/name-rules/candidates";

export function fetchCandidates(api: AdminApi): Promise<ApiResult<CandidatesView>> {
  return api.request(ROOT, { schema: candidatesViewSchema });
}

export function acceptCandidate(api: AdminApi, candidateId: string, body: AcceptBody): Promise<ApiResult<z.infer<typeof acceptedSchema>>> {
  return api.request(`${ROOT}/${encodeURIComponent(candidateId)}/accept`, { method: "POST", body, schema: acceptedSchema });
}

export function dismissCandidate(api: AdminApi, candidateId: string): Promise<ApiResult<{ dismissed: true }>> {
  return api.request(`${ROOT}/${encodeURIComponent(candidateId)}/dismiss`, { method: "POST", schema: z.object({ dismissed: z.literal(true) }) });
}

/** Как искать по умолчанию: слово — целиком, пара — точной фразой. */
export function defaultKind(candidate: Pick<Candidate, "kind">): AcceptKind {
  return candidate.kind === "word" ? "word" : "exact";
}

export function kindTitle(kind: CandidateKind): string {
  return kind === "word" ? "Слово" : "Пара слов";
}

/** Подпись над таблицей; нет расчёта и пустой список — отдельные тексты. */
export function candidatesNote(view: CandidatesView): string {
  if (view.computedAt === null) return "Расчёт ещё не запускался — он идёт каждую ночь в 03:15 UTC";
  if (view.items.length === 0) return `Пока ни одно слово не набрало ${String(view.minPlayers)} игроков`;
  return `Слова и пары слов, которые встретились у ${String(view.minPlayers)} и более разных игроков за ${String(view.windowDays)} суток. Ники и аккаунты не сохраняются — только слово и число игроков. Считается каждую ночь. Посчитано: ${formatDateTime(view.computedAt)}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** «12 окт»: день и месяц по UTC, без времени — расчёт идёт по суткам. */
export function firstSeenText(iso: string): string {
  return DAY_FORMAT.format(new Date(iso)).replace(/\.$/u, "");
}
