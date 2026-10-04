import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import {
  RESTRICTION_CATALOG,
  RESTRICTION_KINDS,
  RESTRICTION_LIMITS,
  RESTRICTION_REASONS,
  RESTRICTION_REASON_KEYS,
  isRestrictionKind,
  type RestrictionKind,
} from "./restriction-catalog.js";
import { SILENT_MESSAGE } from "./restrictions-errors.js";
import { REPLACED_COMMENT, type RestrictionRow } from "./restrictions.repository.js";

/** Наложение из панели — как его разбирает сервер. */
export const imposeSchema = z
  .object({
    kinds: z
      .array(z.enum(RESTRICTION_KINDS))
      .min(1)
      .max(RESTRICTION_KINDS.length)
      .refine((kinds) => new Set(kinds).size === kinds.length, { message: "вид повторяется" }),
    /** `null` — бессрочно */
    endsAt: z.iso.datetime({ offset: true }).nullable(),
    reason: z.enum(RESTRICTION_REASON_KEYS),
    comment: z.string().trim().max(RESTRICTION_LIMITS.commentMax).nullable(),
    notify: z.boolean(),
  })
  .strict();

export type ImposeInput = z.infer<typeof imposeSchema>;

/** Предпросмотр в панели — то же, что наложение, без комментария: его игрок не видит. */
export const previewSchema = imposeSchema.pick({ kinds: true, endsAt: true, reason: true, notify: true });

export type PreviewInput = z.infer<typeof previewSchema>;

export const liftSchema = z.object({ comment: z.string().trim().min(1).max(RESTRICTION_LIMITS.commentMax) }).strict();

/** Действует — не снято и срок не вышел. */
export function isActive(row: Pick<RestrictionRow, "liftedAt" | "endsAt">, at: Date): boolean {
  return row.liftedAt === null && (row.endsAt === null || row.endsAt.getTime() > at.getTime());
}

/** Что не так со сроком; `null` — годится. */
export function termProblem(endsAt: Date | null, at: Date): string | null {
  if (endsAt === null) return null;
  const left = endsAt.getTime() - at.getTime();
  if (left < RESTRICTION_LIMITS.minTermMs) return "Срок уже прошёл или вот-вот пройдёт — выберите дату позже";
  if (left > RESTRICTION_LIMITS.maxTermMs) return "Дольше пяти лет — это «бессрочно», выберите его";
  return null;
}

/** Что не так с набором; `null` — годится. Молча нельзя накладывать то, что игрок увидит всё равно. */
export function imposeProblem(kinds: readonly RestrictionKind[], notify: boolean): string | null {
  if (notify) return null;
  const loud = kinds.find((kind) => !RESTRICTION_CATALOG[kind].silentAllowed);
  return loud === undefined ? null : `«${RESTRICTION_CATALOG[loud].title}» молча не накладывается: игрок всё равно увидит отказ`;
}

const dateTime = new Intl.DateTimeFormat("ru-RU", { timeZone: GAME_DAY_TIME_ZONE, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Срок словами для игрока — по Москве, как игровые сутки. Строка собирается
 * из частей даты: связку между датой и временем версии ICU пишут по-разному
 * («, » или « в »), а игрок и тесты должны видеть одно.
 */
export function untilText(endsAt: Date | null): string {
  if (endsAt === null) return "бессрочно";
  const part = (type: Intl.DateTimeFormatPartTypes) => dateTime.formatToParts(endsAt).find((item) => item.type === type)?.value ?? "";
  return `до ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")} МСК`;
}

/** Шаблон по ключу из базы; незнакомый ключ — запись новее кода — читается как «другое». */
const REASONS: ReadonlyMap<string, { title: string; player: string }> = new Map(Object.entries(RESTRICTION_REASONS));

function reasonOf(reason: string): { title: string; player: string } {
  return REASONS.get(reason) ?? RESTRICTION_REASONS.other;
}

export function reasonText(reason: string): string {
  return reasonOf(reason).player;
}

function titleOf(kind: string): string {
  return isRestrictionKind(kind) ? RESTRICTION_CATALOG[kind].title : kind;
}

/** Отказ игроку словами: что закрыто, до какого числа и почему. */
export function playerMessage(row: Pick<RestrictionRow, "kind" | "endsAt" | "reason">): string {
  return `${titleOf(row.kind)} — закрыто ${untilText(row.endsAt)}. Причина: ${reasonText(row.reason)}`;
}

/** Текст отказа при входе — его хранит `account.ban_reason`. */
export function banMessage(row: Pick<RestrictionRow, "endsAt" | "reason">): string {
  return `Аккаунт заблокирован ${untilText(row.endsAt)}. Причина: ${reasonText(row.reason)}`;
}

/** Тень рейтинга: игрок не видит ничего — себя в доске он видит на своём месте. */
export const SHADOW_TEXT = "Ничего: в рейтинге игрок видит себя на своём месте, другие его не видят";

/**
 * Что увидит игрок, упёршись в ограничение, — тем же кодом, что отказ
 * (docs/35-stage4-plan.md Р83): панель показывает текст, а не макет.
 */
export function shownText(kind: RestrictionKind, endsAt: Date | null, reason: string, notify: boolean): string {
  if (kind === "all") return banMessage({ endsAt, reason });
  if (notify) return playerMessage({ kind, endsAt, reason });
  return kind === "leaderboard" ? SHADOW_TEXT : SILENT_MESSAGE;
}

/** Что игрок видит о своих ограничениях — только те, о которых решили сообщить. */
export interface PlayerRestrictionView {
  kind: string;
  title: string;
  endsAt: string | null;
  /**
   * Срок словами — тем же кодом, что текст отказа и предпросмотр в панели
   * (Р83): плашка клиента показывает его как есть и не форматирует дату сама.
   */
  until: string;
  reason: string;
}

export function playerView(row: RestrictionRow): PlayerRestrictionView {
  return { kind: row.kind, title: titleOf(row.kind), endsAt: row.endsAt?.toISOString() ?? null, until: untilText(row.endsAt), reason: reasonText(row.reason) };
}

export type RestrictionState = "active" | "expired" | "lifted" | "replaced";

export function stateOf(row: RestrictionRow, at: Date): RestrictionState {
  if (row.liftedAt !== null) return row.liftComment === REPLACED_COMMENT ? "replaced" : "lifted";
  return isActive(row, at) ? "active" : "expired";
}

/** Строка истории для панели. Имена команды — подписью, id остаётся для журнала. */
export interface RestrictionView {
  restrictionId: string;
  kind: string;
  title: string;
  state: RestrictionState;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  reasonTitle: string;
  comment: string | null;
  notify: boolean;
  imposedBy: { accountId: string; name: string } | null;
  liftedAt: string | null;
  liftedBy: { accountId: string; name: string } | null;
  liftComment: string | null;
}

export function restrictionView(row: RestrictionRow, at: Date, names: ReadonlyMap<string, string>): RestrictionView {
  const person = (accountId: string | null) => (accountId === null ? null : { accountId, name: names.get(accountId) ?? "удалённый аккаунт" });
  return {
    restrictionId: row.restrictionId,
    kind: row.kind,
    title: titleOf(row.kind),
    state: stateOf(row, at),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    reason: row.reason,
    reasonTitle: reasonOf(row.reason).title,
    comment: row.comment,
    notify: row.notify,
    imposedBy: person(row.imposedBy),
    liftedAt: row.liftedAt?.toISOString() ?? null,
    liftedBy: person(row.liftedBy),
    liftComment: row.liftComment,
  };
}
