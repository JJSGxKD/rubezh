import { randomUUID } from "node:crypto";
import type { Role } from "../../src/modules/roles/permissions.js";
import type { AuditEntry, AuditRecord, RolesRepository } from "../../src/modules/roles/roles.repository.js";

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

  async rolesOf(accountId: string): Promise<Role[]> {
    return [...(this.byAccount.get(accountId) ?? [])];
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
    this.entries.push({ ...entry, entryId: randomUUID(), createdAt: new Date() });
  }

  async recentAudit(limit: number): Promise<AuditRecord[]> {
    return [...this.entries].reverse().slice(0, limit);
  }
}
