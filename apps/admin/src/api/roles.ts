import { z } from "zod";
import { SECTIONS, visibleSections } from "../routes";
import type { AdminApi, ApiResult } from "./client";

/**
 * Роли (`/admin/roles`, docs/29-admin-panel.md §3). Состав ролей — код на
 * сервере; здесь только имена для человека. Журнал аудита — `audit.ts`.
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

/**
 * Зачем роль — одной фразой, по матрице docs/29-admin-panel.md §3.1. Что
 * именно она откроет в панели, считается из прав (`sectionsOfRole`), а не
 * пишется здесь руками: перечень разделов от фразы не разойдётся.
 */
const ROLE_PURPOSE: Readonly<Record<string, string>> = {
  owner: "Всё, включая выдачу ролей, курс выплат и ручные начисления. Тому, кто отвечает за проект.",
  admin: "Операционка: игроки, реклама, флаги, настройки, рассылки с одобрением. Без ролей и денег.",
  game_designer: "Баланс и контент: задания, журнал обновлений, аналитика геймплея и экономики.",
  moderator: "Игроки без платёжных данных: блокировки, сообщения, разбор подозрительных забегов.",
  marketer: "Привлечение: воронка, ссылки, партнёры, промокоды, акции, рассылки без одобрения.",
  finance: "Курсы и выручка, подготовка выплат партнёрам. Период закрывает только владелец.",
  analyst: "Только чтение аналитики, без персональных данных игроков.",
  stakeholder: "Свой расчёт распределения дохода и сводный отчёт — с бухгалтерией.",
};

export function rolePurpose(role: string): string {
  return ROLE_PURPOSE[role] ?? "";
}

/** Какие разделы откроет роль сама по себе — по её правам. */
export function sectionsOfRole(permissions: readonly string[]): string {
  const titles = visibleSections(permissions).map((section) => section.title);
  if (titles.length === 0) return "в панели пока ни одного раздела";
  return titles.length === SECTIONS.length ? "все разделы" : titles.join(", ");
}

export const assignmentSchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  role: z.string(),
  grantedBy: z.string().nullable(),
  grantedByName: z.string().nullable(),
  grantedAt: z.string(),
});

export type Assignment = z.infer<typeof assignmentSchema>;

const assignmentsSchema = z.object({
  assignments: z.array(assignmentSchema),
  roles: z.array(z.object({ role: z.string(), permissions: z.array(z.string()) })),
});
export type Assignments = z.infer<typeof assignmentsSchema>;

const candidateSchema = z.object({ accountId: z.string(), displayName: z.string(), platformUserId: z.string(), roles: z.array(z.string()) });
export type RoleCandidate = z.infer<typeof candidateSchema>;

/** Человек команды — строкой: роли вместе, а не строка на каждую выдачу. */
export interface TeamMember {
  accountId: string;
  displayName: string | null;
  /** в порядке ролей `ROLE_NAMES`: владелец первым */
  assignments: Assignment[];
  /** с какой выдачи человек в команде */
  since: string;
}

export function teamOf(assignments: readonly Assignment[]): TeamMember[] {
  const order = (role: string) => {
    const index = ROLE_NAMES.findIndex(([id]) => id === role);
    return index === -1 ? ROLE_NAMES.length : index;
  };
  const members = new Map<string, TeamMember>();
  for (const assignment of assignments) {
    const member = members.get(assignment.accountId) ?? { accountId: assignment.accountId, displayName: assignment.displayName, assignments: [], since: assignment.grantedAt };
    member.assignments.push(assignment);
    if (assignment.grantedAt < member.since) member.since = assignment.grantedAt;
    members.set(assignment.accountId, member);
  }
  return [...members.values()]
    .map((member) => ({ ...member, assignments: [...member.assignments].sort((a, b) => order(a.role) - order(b.role)) }))
    .sort((a, b) => order(a.assignments[0]?.role ?? "") - order(b.assignments[0]?.role ?? "") || a.since.localeCompare(b.since));
}

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

export function fetchAssignments(api: AdminApi): Promise<ApiResult<Assignments>> {
  return api.request("/roles", { schema: assignmentsSchema });
}

/** Кто это — пока вводят; `null` — такого аккаунта нет. */
export function fetchCandidate(api: AdminApi, target: RoleTarget): Promise<ApiResult<{ candidate: RoleCandidate | null }>> {
  return api.request("/roles/candidate", { query: target, schema: z.object({ candidate: candidateSchema.nullable() }) });
}

export function grantRole(api: AdminApi, target: RoleTarget, role: string): Promise<ApiResult<{ granted: boolean }>> {
  return api.request("/roles/grant", { method: "POST", body: { ...target, role }, schema: z.object({ granted: z.boolean() }) });
}

export function revokeRole(api: AdminApi, target: RoleTarget, role: string): Promise<ApiResult<{ revoked: boolean; sessionsRevoked: number }>> {
  return api.request("/roles/revoke", { method: "POST", body: { ...target, role }, schema: z.object({ revoked: z.boolean(), sessionsRevoked: z.number() }) });
}

/** «Было → стало» одной строкой для таблицы; длинное обрезается — целиком оно в базе. */
export function compactJson(value: unknown, max = 120): string {
  if (value === undefined || value === null) return "—";
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
