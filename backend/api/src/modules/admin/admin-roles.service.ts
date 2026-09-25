import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import type { Role } from "../roles/permissions.js";
import type { AuditRecord } from "../roles/roles.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { AdminSessionService } from "./admin-session.service.js";
import type { RoleTarget } from "./dto/admin.dto.js";

/**
 * Роли и журнал в панели (docs/29-admin-panel.md §3, §8). Выдача и отзыв —
 * дело `RolesService`: там права, аудит и запрет трогать себя. Здесь —
 * поиск человека по идентификатору площадки, имена в списке и отзыв сессий
 * панели у того, кто остался без ролей: доступ снимается сразу, а не по сроку cookie.
 */

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
    // Имена — по одному запросу на аккаунт: ролей у команды десятки, а имя в
    // списке избавляет от второго похода в карточку.
    const names = new Map<string, string | null>();
    for (const accountId of new Set(rows.map((row) => row.accountId))) {
      names.set(accountId, (await this.accounts.byId(accountId))?.displayName ?? null);
    }
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

  async audit(actor: AccountRef, limit: number): Promise<AuditRecord[]> {
    return await this.roles.recentAudit(actor, limit);
  }

  private async resolve(target: RoleTarget): Promise<string> {
    if (target.accountId !== undefined) return target.accountId;
    const account = await this.accounts.byPlatformUser(target.platform, target.platformUserId ?? "");
    // Аккаунт заводится входом: пока человек не открыл игру или бота, выдавать роль некому.
    if (account === null) throw new ValidationError("Аккаунт не найден — пусть сначала откроет игру");
    return account.accountId;
  }
}
