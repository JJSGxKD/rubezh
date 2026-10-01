import type { Role } from "../../src/modules/roles/permissions.js";
import type { AuditEntry, AuditQuery, AuditRecord, RoleAssignment, RolesRepository } from "../../src/modules/roles/roles.repository.js";

/**
 * Роли и журнал в памяти — для тестов сервиса. Смысл тот же, что у
 * реализации на Prisma: повторная выдача не событие, журнал только
 * дописывается.
 */
export class MemoryRolesRepository implements RolesRepository {
  /** запись в журнал падает — так проверяется, что действие от этого не срывается */
  failAudit = false;
  readonly entries: AuditRecord[] = [];
  /** кто выдал роль: `null` — заполнение на старте, а не человек */
  readonly grantedBy = new Map<string, string | null>();
  private readonly byAccount = new Map<string, Set<Role>>();
  /**
   * id записей растут по порядку записи: записи одной миллисекунды журнал
   * упорядочивает по id, и тесту нужен порядок, в котором их писали, а не
   * случайный.
   */
  private sequence = 0;

  async rolesOf(accountId: string): Promise<Role[]> {
    return [...(this.byAccount.get(accountId) ?? [])];
  }

  async assignments(): Promise<RoleAssignment[]> {
    const result: RoleAssignment[] = [];
    for (const [accountId, roles] of this.byAccount) {
      for (const role of roles) result.push({ accountId, role, grantedBy: this.grantedBy.get(`${accountId}:${role}`) ?? null, grantedAt: new Date(0) });
    }
    return result;
  }

  async grant(accountId: string, role: Role, grantedBy: string | null): Promise<boolean> {
    const roles = this.byAccount.get(accountId) ?? new Set<Role>();
    if (roles.has(role)) return false;
    roles.add(role);
    this.byAccount.set(accountId, roles);
    this.grantedBy.set(`${accountId}:${role}`, grantedBy);
    return true;
  }

  async revoke(accountId: string, role: Role): Promise<boolean> {
    return this.byAccount.get(accountId)?.delete(role) ?? false;
  }

  async hasOwner(): Promise<boolean> {
    return [...this.byAccount.values()].some((roles) => roles.has("owner"));
  }

  async append(entry: AuditEntry): Promise<void> {
    if (this.failAudit) throw new Error("журнал недоступен");
    this.sequence += 1;
    this.entries.push({ ...entry, entryId: `00000000-0000-4000-8000-${this.sequence.toString(16).padStart(12, "0")}`, createdAt: new Date() });
  }

  async recentAudit(limit: number): Promise<AuditRecord[]> {
    return [...this.entries].reverse().slice(0, limit);
  }

  async auditPage(query: AuditQuery): Promise<AuditRecord[]> {
    const { before } = query;
    return [...this.entries]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.entryId < b.entryId ? 1 : a.entryId > b.entryId ? -1 : 0))
      .filter((entry) => query.actions.length === 0 || query.actions.some((prefix) => entry.action.startsWith(prefix)))
      .filter((entry) => query.actorAccountId === null || entry.actorAccountId === query.actorAccountId)
      .filter((entry) => query.target === null || entry.target === query.target)
      .filter(
        (entry) =>
          before === null ||
          entry.createdAt.getTime() < before.createdAt.getTime() ||
          (entry.createdAt.getTime() === before.createdAt.getTime() && entry.entryId < before.entryId),
      )
      .slice(0, query.limit);
  }
}
