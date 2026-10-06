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

/** Где остановилась прошлая страница журнала: время и id последней записи. */
export interface AuditCursor {
  createdAt: Date;
  entryId: string;
}

/** Страница журнала для панели — свежие первыми, с отбором. */
export interface AuditQuery {
  limit: number;
  /** `null` — с самых свежих; иначе — записи старше курсора */
  before: AuditCursor | null;
  /** начала имён действий: `roles.`, `admin.login`; пусто — все действия */
  actions: readonly string[];
  /** `null` — кто угодно */
  actorAccountId: string | null;
  /** `null` — над чем угодно */
  target: string | null;
}

export const ROLES_REPOSITORY = Symbol("ROLES_REPOSITORY");

/** Кому какая роль выдана и кем — раздел ролей в панели. */
export interface RoleAssignment {
  accountId: string;
  role: Role;
  grantedBy: string | null;
  grantedAt: Date;
}

export interface RolesRepository {
  rolesOf(accountId: string): Promise<Role[]>;
  /** Все выданные роли, свежие первыми */
  assignments(): Promise<RoleAssignment[]>;
  /** `false` — роль уже была: повторная выдача не событие и в журнал не идёт */
  grant(accountId: string, role: Role, grantedBy: string | null): Promise<boolean>;
  /** `false` — роли и не было */
  revoke(accountId: string, role: Role): Promise<boolean>;
  /** Есть ли в системе хоть один владелец — от этого зависит аварийный путь */
  hasOwner(): Promise<boolean>;
  append(entry: AuditEntry): Promise<void>;
  /** Последние записи журнала, новые первыми */
  recentAudit(limit: number): Promise<AuditRecord[]>;
  /** Страница журнала с отбором; при равном времени порядок держит id — курсор не теряет и не повторяет записи */
  auditPage(query: AuditQuery): Promise<AuditRecord[]>;
}

@Injectable()
export class PrismaRolesRepository implements RolesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async rolesOf(accountId: string): Promise<Role[]> {
    const rows = await this.prisma.accountRole.findMany({ where: { accountId }, select: { role: true } });
    return rows.map((row) => row.role as Role);
  }

  async assignments(): Promise<RoleAssignment[]> {
    // Ролей — десятки на всю команду, страниц не нужно.
    const rows = await this.prisma.accountRole.findMany({ orderBy: { grantedAt: "desc" } });
    return rows.map((row) => ({ accountId: row.accountId, role: row.role as Role, grantedBy: row.grantedBy, grantedAt: row.grantedAt }));
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
    return rows.map(recordOf);
  }

  async auditPage(query: AuditQuery): Promise<AuditRecord[]> {
    const { before } = query;
    const rows = await this.prisma.auditEntry.findMany({
      where: {
        AND: [
          query.actions.length === 0 ? {} : { OR: query.actions.map((prefix) => ({ action: { startsWith: prefix } })) },
          query.actorAccountId === null ? {} : { actorAccountId: query.actorAccountId },
          query.target === null ? {} : { target: query.target },
          before === null ? {} : { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, entryId: { lt: before.entryId } }] },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { entryId: "desc" }],
      take: query.limit,
    });
    return rows.map(recordOf);
  }
}

function recordOf(row: { entryId: string; actorAccountId: string | null; action: string; target: string | null; before: unknown; after: unknown; createdAt: Date }): AuditRecord {
  return {
    entryId: row.entryId,
    actorAccountId: row.actorAccountId,
    action: row.action,
    target: row.target,
    before: row.before,
    after: row.after,
    createdAt: row.createdAt,
  };
}

/**
 * Пустое состояние в JSON-колонке. У Prisma для этого отдельное значение:
 * `null` там означал бы «не трогать поле», а нам нужен записанный `null` —
 * «состояния не было».
 */
function toJson(value: unknown): object | typeof DbNull {
  return value === undefined || value === null ? DbNull : (value as object);
}
