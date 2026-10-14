import { z } from "zod";
import { formatDateTime, plural } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Ограничения игрока в панели (docs/35-stage4-plan.md Р75, WP44, О40;
 * docs/29-admin-panel.md §3.4): закрыть то, чем игрок злоупотребил, на срок.
 * Что закрывает каждый вид и что увидит игрок — со слов сервера: каталог и
 * предпросмотр приходят от него, панель не держит своих копий текстов.
 */

const iso = z.string();

const kindSchema = z.object({
  kind: z.string(),
  title: z.string(),
  effect: z.string(),
  permission: z.string(),
  silentAllowed: z.boolean(),
  /** скрытый вид приходит только тем, у кого есть его право; сервер старше панели поля не шлёт — не скрыт */
  hidden: z.boolean().default(false),
});
const reasonSchema = z.object({ reason: z.string(), title: z.string(), player: z.string() });

export const restrictionCatalogSchema = z.object({ kinds: z.array(kindSchema), reasons: z.array(reasonSchema) });
export type RestrictionCatalog = z.infer<typeof restrictionCatalogSchema>;
export type RestrictionKindInfo = z.infer<typeof kindSchema>;

const personSchema = z.object({ accountId: z.string(), name: z.string() }).nullable();

export const restrictionSchema = z.object({
  restrictionId: z.string(),
  kind: z.string(),
  title: z.string(),
  /** `active`, `expired`, `lifted`, `replaced`; незнакомое — сервер новее панели */
  state: z.string(),
  startsAt: iso,
  endsAt: iso.nullable(),
  reason: z.string(),
  reasonTitle: z.string(),
  comment: z.string().nullable(),
  notify: z.boolean(),
  imposedBy: personSchema,
  liftedAt: iso.nullable(),
  liftedBy: personSchema,
  liftComment: z.string().nullable(),
});
export type Restriction = z.infer<typeof restrictionSchema>;

export const restrictionPreviewSchema = z.object({
  problem: z.string().nullable(),
  shown: z.array(z.object({ kind: z.string(), title: z.string(), text: z.string() })),
});
export type RestrictionPreview = z.infer<typeof restrictionPreviewSchema>;

const restrictResultSchema = z.object({ restrictions: z.array(restrictionSchema), revokedSessions: z.number() });

/** Блокировка целиком — тот же вид ограничения, но под своим правом и всегда видна игроку. */
export const BAN_KIND = "all";
/** Потолок комментария — тот же, что `RESTRICTION_LIMITS.commentMax` на сервере. */
export const COMMENT_MAX = 500;

/** Сроки кнопками (О40): чаще всего наказывают на день, три, неделю или месяц. */
export const TERMS = [
  { id: "1d", title: "1 день", days: 1 },
  { id: "3d", title: "3 дня", days: 3 },
  { id: "7d", title: "7 дней", days: 7 },
  { id: "30d", title: "30 дней", days: 30 },
  { id: "forever", title: "Бессрочно", days: null },
  { id: "date", title: "До даты", days: null },
] as const;
export type TermId = (typeof TERMS)[number]["id"];

export const STATE_TITLES: Readonly<Record<string, string>> = { active: "действует", expired: "срок вышел", lifted: "снято", replaced: "заменено новым" };

export interface RestrictDraft {
  kinds: string[];
  term: TermId;
  /** значение поля `datetime-local` в часах браузера — для «До даты» */
  until: string;
  reason: string;
  comment: string;
  notify: boolean;
}

export function emptyDraft(): RestrictDraft {
  return { kinds: [], term: "3d", until: "", reason: "", comment: "", notify: true };
}

const DAY_MS = 86_400_000;

/** Конец срока строкой ISO; `null` — бессрочно; `undefined` — дата не задана или не дата. */
export function endsAtOf(draft: Pick<RestrictDraft, "term" | "until">, now: Date): string | null | undefined {
  if (draft.term === "forever") return null;
  if (draft.term === "date") {
    const at = new Date(draft.until);
    return draft.until === "" || Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  }
  const days = TERMS.find((term) => term.id === draft.term)?.days ?? 1;
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

const NO_HIDDEN: ReadonlySet<string> = new Set();

/** Скрытые виды каталога — те, что пришли с `hidden`; без права вида их в каталоге нет. */
export function hiddenKindsOf(catalog: RestrictionCatalog): ReadonlySet<string> {
  return new Set(catalog.kinds.filter((item) => item.hidden).map((item) => item.kind));
}

/** Виды, которые отмечают галочками: все, кроме блокировки целиком — у неё своя кнопка. */
export function pickableKinds(catalog: RestrictionCatalog): RestrictionKindInfo[] {
  return catalog.kinds.filter((item) => item.kind !== BAN_KIND);
}

/** Выбран ли скрытый вид — тогда «сообщить игроку» выключено и недоступно. */
export function notifyLocked(draft: Pick<RestrictDraft, "kinds">, hidden: ReadonlySet<string> = NO_HIDDEN): boolean {
  return draft.kinds.includes(BAN_KIND) || draft.kinds.some((kind) => hidden.has(kind));
}

/** Блокировку игрок видит при входе — молча её не наложить; скрытый вид, наоборот, всегда молча. */
export function notifyOf(draft: Pick<RestrictDraft, "kinds" | "notify">, hidden: ReadonlySet<string> = NO_HIDDEN): boolean {
  if (draft.kinds.some((kind) => hidden.has(kind))) return false;
  return draft.kinds.includes(BAN_KIND) || draft.notify;
}

/**
 * Галочка вида. Блокировка целиком и скрытый вид идут по одному: выбор любого
 * снимает остальные, и выбор обычного вида снимает их. Скрытому «сообщить»
 * выключается — у него нет ничего, что можно сообщить.
 */
export function toggleKind(draft: RestrictDraft, kind: string, checked: boolean, hidden: ReadonlySet<string> = NO_HIDDEN): RestrictDraft {
  if (hidden.has(kind) && checked) return { ...draft, kinds: [kind], notify: false };
  const kinds = !checked ? draft.kinds.filter((item) => item !== kind) : kind === BAN_KIND ? [BAN_KIND] : [...draft.kinds.filter((item) => item !== kind && !hidden.has(item)), kind];
  // Ушли от скрытого вида — «сообщить игроку» снова доступно и включено, как в пустом диалоге.
  const left = draft.kinds.some((item) => hidden.has(item)) && !kinds.some((item) => hidden.has(item));
  return { ...draft, kinds, notify: left ? emptyDraft().notify : draft.notify };
}

/** Что не так с черновиком до отправки; `null` — готов. Срок и молчание сверх этого проверяет сервер предпросмотром. */
export function draftProblem(draft: RestrictDraft, now: Date): string | null {
  if (draft.kinds.length === 0) return "Отметьте, что закрыть";
  if (endsAtOf(draft, now) === undefined) return "Укажите дату, до которой закрыть";
  if (draft.reason === "") return "Выберите причину — её увидит игрок";
  if (draft.comment.trim().length > COMMENT_MAX) return `Комментарий — до ${String(COMMENT_MAX)} символов`;
  return null;
}

export interface ImposeBody {
  kinds: string[];
  endsAt: string | null;
  reason: string;
  comment: string | null;
  notify: boolean;
}

/** Тело наложения; `null` — черновик не готов (причина — `draftProblem`). */
export function imposeBody(draft: RestrictDraft, now: Date, hidden: ReadonlySet<string> = NO_HIDDEN): ImposeBody | null {
  const endsAt = endsAtOf(draft, now);
  if (draftProblem(draft, now) !== null || endsAt === undefined) return null;
  const comment = draft.comment.trim();
  return { kinds: [...draft.kinds], endsAt, reason: draft.reason, comment: comment === "" ? null : comment, notify: notifyOf(draft, hidden) };
}

/** Подпись главной кнопки — что случится по нажатию, а не «Сохранить». */
export function submitLabel(draft: RestrictDraft, now: Date): string {
  const verb = draft.kinds.includes(BAN_KIND) ? "Заблокировать" : "Ограничить";
  if (draft.term === "forever") return `${verb} бессрочно`;
  if (draft.term === "date") {
    const endsAt = endsAtOf(draft, now);
    return typeof endsAt === "string" ? `${verb} до ${formatDateTime(endsAt)}` : verb;
  }
  return `${verb} на ${TERMS.find((term) => term.id === draft.term)?.title ?? ""}`;
}

/** Сколько осталось словами — крупнейшие две единицы: «ещё 2 дня 3 часа», «ещё 45 минут». */
export function leftText(endsAt: string | null, now: Date): string {
  if (endsAt === null) return "бессрочно";
  const left = new Date(endsAt).getTime() - now.getTime();
  if (left <= 0) return "срок вышел";
  const minutes = Math.ceil(left / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const unit = (count: number, forms: readonly [string, string, string]) => `${String(count)} ${plural(count, forms)}`;
  if (days > 0) return `ещё ${unit(days, ["день", "дня", "дней"])}${hours > 0 ? ` ${unit(hours, ["час", "часа", "часов"])}` : ""}`;
  if (hours > 0) return `ещё ${unit(hours, ["час", "часа", "часов"])}${rest > 0 ? ` ${unit(rest, ["минута", "минуты", "минут"])}` : ""}`;
  return `ещё ${unit(rest, ["минута", "минуты", "минут"])}`;
}

/** Чем кончилось — для истории: кто и почему снял или что срок вышел сам. */
export function outcomeText(row: Restriction): string {
  if (row.state === "active") return "действует";
  if (row.state === "expired") return `срок вышел ${formatDateTime(row.endsAt)}`;
  if (row.state === "replaced") return `заменено новым ${formatDateTime(row.liftedAt)}`;
  if (row.state === "lifted") return `снял ${row.liftedBy?.name ?? "—"} ${formatDateTime(row.liftedAt)}: «${row.liftComment ?? ""}»`;
  return row.state;
}

export function fetchRestrictionCatalog(api: AdminApi): Promise<ApiResult<RestrictionCatalog>> {
  return api.request("/restrictions/catalog", { schema: restrictionCatalogSchema });
}

export function fetchRestrictions(api: AdminApi, accountId: string): Promise<ApiResult<{ restrictions: Restriction[] }>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/restrictions`, { schema: z.object({ restrictions: z.array(restrictionSchema) }) });
}

export function previewRestriction(api: AdminApi, body: Omit<ImposeBody, "comment">): Promise<ApiResult<RestrictionPreview>> {
  return api.request("/restrictions/preview", { method: "POST", body, schema: restrictionPreviewSchema });
}

export function imposeRestriction(api: AdminApi, accountId: string, body: ImposeBody): Promise<ApiResult<z.infer<typeof restrictResultSchema>>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/restrictions`, { method: "POST", body, schema: restrictResultSchema });
}

export function liftRestriction(api: AdminApi, restrictionId: string, comment: string): Promise<ApiResult<Restriction>> {
  return api.request(`/restrictions/${encodeURIComponent(restrictionId)}/lift`, { method: "POST", body: { comment }, schema: restrictionSchema });
}
