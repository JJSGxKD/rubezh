import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Роли и журнал аудита (`/admin/roles`, `/admin/audit`, docs/29-admin-panel.md §3).
 * Состав ролей — код на сервере; здесь только имена для человека.
 */
export const ROLE_NAMES: readonly (readonly [string, string])[] = [
  ["owner", "Владелец"],
  ["admin", "Администратор"],
  ["game_designer", "Геймдизайнер"],
  ["moderator", "Модератор"],
  ["marketer", "Маркетолог"],
  ["finance", "Финансы"],
  ["analyst", "Аналитик"],
  ["stakeholder", "Участник проекта"],
];

export function roleName(role: string): string {
  return ROLE_NAMES.find(([id]) => id === role)?.[1] ?? role;
}

export const assignmentSchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  role: z.string(),
  grantedBy: z.string().nullable(),
  grantedAt: z.string(),
});

export const auditEntrySchema = z.object({
  entryId: z.string(),
  actorAccountId: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  createdAt: z.string(),
});

export type Assignment = z.infer<typeof assignmentSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * Кому выдать или у кого снять: по Telegram ID удобнее, чем по uuid, — а
 * uuid виден в карточке игрока. Строка из формы разбирается здесь:
 * uuid — аккаунт, цифры — ID на площадке, остальное — ошибка до запроса.
 */
export type RoleTarget = { accountId: string } | { platformUserId: string; platform: "telegram" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function roleTargetOf(input: string): RoleTarget | null {
  const text = input.trim();
  if (UUID.test(text)) return { accountId: text.toLowerCase() };
  if (/^\d{1,32}$/.test(text)) return { platformUserId: text, platform: "telegram" };
  return null;
}

export function fetchAssignments(api: AdminApi): Promise<ApiResult<{ assignments: Assignment[] }>> {
  return api.request("/roles", { schema: z.object({ assignments: z.array(assignmentSchema) }) });
}

export function grantRole(api: AdminApi, target: RoleTarget, role: string): Promise<ApiResult<{ granted: boolean }>> {
  return api.request("/roles/grant", { method: "POST", body: { ...target, role }, schema: z.object({ granted: z.boolean() }) });
}

export function revokeRole(api: AdminApi, target: RoleTarget, role: string): Promise<ApiResult<{ revoked: boolean; sessionsRevoked: number }>> {
  return api.request("/roles/revoke", { method: "POST", body: { ...target, role }, schema: z.object({ revoked: z.boolean(), sessionsRevoked: z.number() }) });
}

export const AUDIT_LIMIT = 200;

export function fetchAudit(api: AdminApi): Promise<ApiResult<{ entries: AuditEntry[] }>> {
  return api.request("/audit", { query: { limit: AUDIT_LIMIT }, schema: z.object({ entries: z.array(auditEntrySchema) }) });
}

/** «Было → стало» одной строкой для таблицы; длинное обрезается — целиком оно в базе. */
export function compactJson(value: unknown, max = 120): string {
  if (value === undefined || value === null) return "—";
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
