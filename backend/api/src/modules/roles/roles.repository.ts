import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { Role } from "./permissions.js";

/**
 * Роли аккаунтов и журнал аудита (docs/34-stage3-plan.md, WP2). Запрос к базе
 * живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

/** Записанный «пустого состояния не было» — не то же самое, что «не трогать поле». */
const DbNull = Prisma.DbNull;

export interface AuditEntry {
  /** `null` — действие системы, а не человека */
  actorAccountId: string | null;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditRecord extends AuditEntry {
  entryId: string;
  createdAt: Date;
}

export const ROLES_REPOSITORY = Symbol("ROLES_REPOSITORY");

export interface RolesRepository {
  rolesOf(accountId: string): Promise<Role[]>;
  /** `false` — роль уже была: повторная выдача не событие и в журнал не идёт */
  grant(accountId: string, role: Role, grantedBy: string | null): Promise<boolean>;
  /** `false` — роли и не было */
  revoke(accountId: string, role: Role): Promise<boolean>;
  /** Есть ли в системе хоть один владелец — от этого зависит аварийный путь */
  hasOwner(): Promise<boolean>;
  append(entry: AuditEntry): Promise<void>;
  /** Последние записи журнала, новые первыми */
  recentAudit(limit: number): Promise<AuditRecord[]>;
}

@Injectable()
export class PrismaRolesRepository implements RolesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async rolesOf(accountId: string): Promise<Role[]> {
    const rows = await this.prisma.accountRole.findMany({ where: { accountId }, select: { role: true } });
    return rows.map((row) => row.role as Role);
  }

  async grant(accountId: string, role: Role, grantedBy: string | null): Promise<boolean> {
    // Повторная выдача не должна падать: администратор мог нажать дважды.
    const created = await this.prisma.accountRole.createMany({
      data: [{ accountId, role, grantedBy }],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async revoke(accountId: string, role: Role): Promise<boolean> {
    const removed = await this.prisma.accountRole.deleteMany({ where: { accountId, role } });
    return removed.count > 0;
  }

  async hasOwner(): Promise<boolean> {
    const owner = await this.prisma.accountRole.findFirst({ where: { role: "owner" }, select: { accountId: true } });
    return owner !== null;
  }

  async append(entry: AuditEntry): Promise<void> {
    await this.prisma.auditEntry.create({
      data: {
        entryId: randomUUID(),
        actorAccountId: entry.actorAccountId,
        action: entry.action,
        target: entry.target ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
      },
    });
  }

  async recentAudit(limit: number): Promise<AuditRecord[]> {
    const rows = await this.prisma.auditEntry.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return rows.map((row) => ({
      entryId: row.entryId,
      actorAccountId: row.actorAccountId,
      action: row.action,
      target: row.target,
      before: row.before,
      after: row.after,
      createdAt: row.createdAt,
    }));
  }
}

/**
 * Пустое состояние в JSON-колонке. У Prisma для этого отдельное значение:
 * `null` там означал бы «не трогать поле», а нам нужен записанный `null` —
 * «состояния не было».
 */
function toJson(value: unknown): object | typeof DbNull {
  return value === undefined || value === null ? DbNull : (value as object);
}
