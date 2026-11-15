import { ROLES, ROLE_PERMISSIONS, type Permission, type Role } from "../roles/permissions.js";
import { CHANGE_TTL_MS, type ChangeRequestRow, type JsonValue } from "./change-request-types.js";

/**
 * Чистые правила заявок (docs/19-content-admin.md §6, tasks/T-0309): срок
 * жизни, равенство «было» с состоянием цели, кто вправе подтвердить. Без Nest
 * и базы — ход заявки в `change-requests.service.ts`.
 */

export function expiresAt(row: Pick<ChangeRequestRow, "createdAt">): Date {
  return new Date(row.createdAt.getTime() + CHANGE_TTL_MS);
}

/** Срок вышел ровно через 72 часа: на последней миллисекунде заявка ещё жива. */
export function isExpired(row: Pick<ChangeRequestRow, "createdAt">, now: Date): boolean {
  return now.getTime() >= expiresAt(row).getTime();
}

/** Канонический вид: ключи объектов по порядку — jsonb порядок ключей не хранит. */
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key] ?? null)]),
    );
  }
  return value;
}

/** Равны ли два значения как JSON, не считая порядка ключей. Порядок элементов массива важен. */
export function sameJson(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Роли, у которых есть право: им уходит уведомление о новой заявке — подтвердить её могут они. */
export function rolesGranting(permission: Permission): Role[] {
  return ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
}
