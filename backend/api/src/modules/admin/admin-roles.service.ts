import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import type { Role } from "../roles/permissions.js";
import type { AuditQuery, AuditRecord } from "../roles/roles.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { AdminSessionService } from "./admin-session.service.js";
import type { RoleTarget } from "./dto/admin.dto.js";

/**
 * Роли и журнал в панели (docs/29-admin-panel.md §3, §8). Выдача и отзыв —
 * дело `RolesService`: там права, аудит и запрет трогать себя. Здесь —
 * поиск человека по идентификатору площадки, имена в списке и отзыв сессий
 * панели у того, кто остался без ролей: доступ снимается сразу, а не по сроку cookie.
 */

/** Запись журнала для панели: имена людей рядом с id — в таблице читают имена. */
export interface AuditView {
  entryId: string;
  actorAccountId: string | null;
  /** `null` — действие системы или аккаунта уже нет */
  actorName: string | null;
  action: string;
  target: string | null;
  /** имя, если объект — аккаунт: выдали роль, заблокировали игрока */
  targetName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditPage {
  entries: AuditView[];
  /** курсор следующей страницы; `null` — дальше записей нет */
  next: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RoleAssignmentView {
  accountId: string;
  displayName: string | null;
  role: Role;
  grantedBy: string | null;
  grantedAt: string;
}

@Injectable()
export class AdminRolesService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly sessions: AdminSessionService,
  ) {}

  async assignments(actor: AccountRef): Promise<RoleAssignmentView[]> {
    const rows = await this.roles.assignments(actor);
    // Имя в списке избавляет от второго похода в карточку.
    const names = await this.accounts.displayNames([...new Set(rows.map((row) => row.accountId))]);
    return rows.map((row) => ({ accountId: row.accountId, displayName: names.get(row.accountId) ?? null, role: row.role, grantedBy: row.grantedBy, grantedAt: row.grantedAt.toISOString() }));
  }

  async grant(actor: AccountRef, target: RoleTarget): Promise<{ granted: boolean }> {
    const accountId = await this.resolve(target);
    return { granted: await this.roles.grant(actor, accountId, target.role as Role) };
  }

  async revoke(actor: AccountRef, target: RoleTarget): Promise<{ revoked: boolean; sessionsRevoked: number }> {
    const accountId = await this.resolve(target);
    const revoked = await this.roles.revoke(actor, accountId, target.role as Role);
    let sessionsRevoked = 0;
    if (revoked) {
      const account = await this.accounts.byId(accountId);
      const left = account === null ? [] : await this.roles.rolesFor({ accountId, platform: account.platform, platformUserId: account.platformUserId });
      if (left.length === 0) sessionsRevoked = await this.sessions.revokeAll(accountId);
    }
    return { revoked, sessionsRevoked };
  }

  /**
   * Страница журнала. Берётся на запись больше страницы — так видно, есть ли
   * продолжение, без отдельного подсчёта. Имена — одним запросом на всю
   * страницу: людей и аккаунтов-объектов в ней единицы, а не сотни.
   */
  async audit(actor: AccountRef, query: AuditQuery): Promise<AuditPage> {
    const rows = await this.roles.auditPage(actor, { ...query, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const ids = new Set<string>();
    for (const row of page) {
      if (row.actorAccountId !== null) ids.add(row.actorAccountId);
      if (typeof row.target === "string" && UUID.test(row.target)) ids.add(row.target.toLowerCase());
    }
    const names = await this.accounts.displayNames([...ids]);
    const last = page.at(-1);
    return {
      entries: page.map((row) => viewOf(row, names)),
      next: rows.length > query.limit && last !== undefined ? `${last.createdAt.toISOString()}_${last.entryId}` : null,
    };
  }

  private async resolve(target: RoleTarget): Promise<string> {
    if (target.accountId !== undefined) return target.accountId;
    const account = await this.accounts.byPlatformUser(target.platform, target.platformUserId ?? "");
    // Аккаунт заводится входом: пока человек не открыл игру или бота, выдавать роль некому.
    if (account === null) throw new ValidationError("Аккаунт не найден — пусть сначала откроет игру");
    return account.accountId;
  }
}

function viewOf(row: AuditRecord, names: ReadonlyMap<string, string>): AuditView {
  const target = row.target ?? null;
  return {
    entryId: row.entryId,
    actorAccountId: row.actorAccountId,
    actorName: row.actorAccountId === null ? null : (names.get(row.actorAccountId) ?? null),
    action: row.action,
    target,
    targetName: target === null ? null : (names.get(target.toLowerCase()) ?? null),
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
