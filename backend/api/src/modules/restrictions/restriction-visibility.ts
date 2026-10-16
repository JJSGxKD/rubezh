import type { Permission } from "../roles/permissions.js";
import { isHiddenKind } from "./restriction-catalog.js";

/**
 * Кому видны скрытые виды ограничений (docs/35-stage4-plan.md Р104, T-0112).
 * Вид «Отдельная доска» меняет только то, какую доску читает аккаунт, и о нём
 * не знает ни игрок, ни сотрудник без особого права: его нет в каталоге, в
 * истории, в списке игроков и в журнале. Здесь — всё, что отличает скрытое от
 * обычного, чтобы сервис ограничений не раздувался.
 */

/** Право видеть скрытые виды, накладывать и снимать их. */
export const HIDDEN_KIND_PERMISSION = "players.board.restrict" as const satisfies Permission;

/**
 * Тексты отказа на кривое тело. Скрытый вид без права отвечает ровно ими: ответ
 * «нет права» подсказал бы, что вид существует.
 */
export const IMPOSE_INVALID_TEXT = "Некорректное ограничение: нужны виды, срок и причина";
export const PREVIEW_INVALID_TEXT = "Некорректный черновик ограничения";

export function hasHiddenKind(kinds: readonly string[]): boolean {
  return kinds.some(isHiddenKind);
}

/** Строки, которые видит актор: без права скрытых видов в них нет. */
export function visibleRows<T extends { kind: string }>(rows: readonly T[], canSeeHidden: boolean): T[] {
  return canSeeHidden ? [...rows] : rows.filter((row) => !isHiddenKind(row.kind));
}

/**
 * Действие журнала при наложении: если наложены только скрытые виды —
 * `players.board.set`, иначе обычное. Журнал без права скрытые действия не
 * отдаёт (`HIDDEN_AUDIT_PREFIX` в `roles/permissions.ts`).
 */
export function imposedAuditAction(kinds: readonly string[]): "players.restrict" | "players.board.set" {
  return kinds.length > 0 && kinds.every(isHiddenKind) ? "players.board.set" : "players.restrict";
}

/** То же при снятии: `players.board.unset` для скрытого вида. */
export function liftedAuditAction(kind: string): "players.unrestrict" | "players.board.unset" {
  return isHiddenKind(kind) ? "players.board.unset" : "players.unrestrict";
}
