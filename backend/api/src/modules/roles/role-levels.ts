import type { Role } from "./permissions.js";

/**
 * Уровни ролей (docs/35-stage4-plan.md Р136, docs/29-admin-panel.md §3.1,
 * tasks/T-0216): порядок — по тому, что роль открывает. Выдать или снять роль
 * может тот, чей наибольший уровень выше и уровня роли, и наибольшего уровня
 * аккаунта, у которого её меняют. Владелец — любые роли, как и раньше.
 * Деньги и доли (`finance`, `stakeholder`) стоят выше админа: их выдаёт только
 * владелец.
 */
export const ROLE_LEVELS: Record<Role, number> = {
  owner: 100,
  stakeholder: 90,
  finance: 90,
  admin: 80,
  game_designer: 50,
  marketer: 50,
  moderator: 40,
  analyst: 30,
};

/** Наибольший уровень из ролей; без ролей — 0. */
export function levelOf(roles: readonly Role[]): number {
  return roles.reduce((top, role) => Math.max(top, ROLE_LEVELS[role]), 0);
}

/**
 * Почему менять нельзя: сама роль не ниже уровня действующего (`role`) или
 * аккаунт, у которого её меняют, не ниже действующего (`account`). `null` — можно.
 */
export function manageDenial(actorRoles: readonly Role[], targetRoles: readonly Role[], role: Role): "role" | "account" | null {
  if (actorRoles.includes("owner")) return null;
  const actor = levelOf(actorRoles);
  if (actor <= ROLE_LEVELS[role]) return "role";
  if (actor <= levelOf(targetRoles)) return "account";
  return null;
}

export function canManage(actorRoles: readonly Role[], targetRoles: readonly Role[], role: Role): boolean {
  return manageDenial(actorRoles, targetRoles, role) === null;
}
