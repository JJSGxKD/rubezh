import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ForbiddenError, ValidationError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import type { AccountPlatform } from "../auth/access-token.js";
import { isDeveloperAccount } from "../auth/dev-login.js";
import { permissionsOf, type Permission, type Role } from "./permissions.js";
import { ROLES_REPOSITORY, type AuditEntry, type RolesRepository } from "./roles.repository.js";
import type { PlatformId } from "../../platforms/ports/platform.js";

/**
 * Кто что может (docs/34-stage3-plan.md, WP2).
 *
 * **Аварийный путь.** Список `ADMIN_TELEGRAM_IDS` даёт роль владельца, но
 * **только пока в системе нет ни одного владельца**. Так решаются обе задачи:
 * первый человек получает доступ на пустой базе, а дальше список перестаёт
 * быть чёрным ходом — роли раздаются ролями. Без такого пути однажды отзовут
 * роль сами себе и останутся без входа вовсе.
 *
 * **Роли не кладутся в токен доступа**, хотя план этапа это предполагал: тогда
 * отзыв роли начинал бы действовать только после протухания токена, то есть с
 * задержкой до четверти часа. Для `players.ban` и `roles.assign` это слишком
 * долго, а стоит мгновенный отзыв одного запроса по индексу на уже
 * авторизованном запросе.
 */

export interface AccountRef {
  accountId: string;
  platform: PlatformId;
  platformUserId: string;
}

@Injectable()
export class RolesService {
  private readonly logger = new Logger("roles");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROLES_REPOSITORY) private readonly repository: RolesRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
  ) {}

  async rolesFor(account: AccountRef): Promise<Role[]> {
    // Разработчик на своей машине — владелец: инструменты команды в браузере
    // открываются без выдачи ролей руками, как раньше при входе заголовком
    // плейтеста. Вне development флага не бывает — процесс с ним не стартует.
    if (this.config.auth.devLogin && isDeveloperAccount(account)) return ["owner"];
    const roles = await this.repository.rolesOf(account.accountId);
    if (roles.length > 0) return roles;
    return (await this.isBreakGlassOwner(account)) ? ["owner"] : [];
  }

  async can(account: AccountRef, permission: Permission): Promise<boolean> {
    return permissionsOf(await this.rolesFor(account)).has(permission);
  }

  /**
   * Права по идентификатору на площадке — так спрашивают бот и плейтест: там
   * сессии нет, есть только Telegram ID отправителя.
   *
   * Аккаунта может не быть вовсе: администратор мог ни разу не открыть игру, а
   * командой бота пользоваться. Тогда остаётся аварийный путь — и он же
   * единственная причина, по которой первый владелец вообще может что-то
   * сделать.
   */
  async canByPlatformUser(platform: string, platformUserId: string, permission: Permission): Promise<boolean> {
    const account = await this.accounts.byPlatformUser(platform as AccountPlatform, platformUserId);
    if (account !== null) {
      return await this.can({ accountId: account.accountId, platform: account.platform, platformUserId }, permission);
    }
    if (!(await this.isEnvAdminWithoutOwner(platform, platformUserId))) return false;
    return permissionsOf(["owner"]).has(permission);
  }

  /** Бросает, если права нет: вызывающему не нужно ветвиться самому. */
  async require(account: AccountRef, permission: Permission): Promise<void> {
    if (await this.can(account, permission)) return;
    // Что именно закрыто, знать необязательно: сообщение не описывает
    // внутреннее устройство (docs/15-engineering-standards.md §7).
    throw new ForbiddenError("Недостаточно прав");
  }

  async grant(actor: AccountRef, accountId: string, role: Role): Promise<boolean> {
    await this.require(actor, "roles.assign");
    ensureNotSelf(actor, accountId, "Выдать роль себе нельзя");

    const granted = await this.repository.grant(accountId, role, actor.accountId);
    if (granted) await this.audit({ actorAccountId: actor.accountId, action: "roles.assign", target: accountId, after: { role } });
    return granted;
  }

  async revoke(actor: AccountRef, accountId: string, role: Role): Promise<boolean> {
    await this.require(actor, "roles.assign");
    ensureNotSelf(actor, accountId, "Отозвать роль у себя нельзя");

    const revoked = await this.repository.revoke(accountId, role);
    if (revoked) await this.audit({ actorAccountId: actor.accountId, action: "roles.revoke", target: accountId, before: { role } });
    return revoked;
  }

  /**
   * Записать действие в журнал. Ошибка записи не роняет само действие: игрок
   * не должен получить отказ оттого, что не записался аудит, — но в лог она
   * попадает, потому что дыра в журнале дороже одной строки.
   */
  async audit(entry: AuditEntry): Promise<void> {
    try {
      await this.repository.append(entry);
    } catch (error: unknown) {
      this.logger.error(`не записано в журнал: ${entry.action} — ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  /**
   * Список в окружении — про Telegram, и работает он только на пустой системе.
   * Запрос «есть ли владелец» делается лишь для тех, у кого своих ролей нет, —
   * то есть почти никогда.
   */
  private async isBreakGlassOwner(account: AccountRef): Promise<boolean> {
    return await this.isEnvAdminWithoutOwner(account.platform, account.platformUserId);
  }

  private async isEnvAdminWithoutOwner(platform: string, platformUserId: string): Promise<boolean> {
    if (platform !== "telegram") return false;
    if (!this.config.adminTelegramIds.has(platformUserId)) return false;
    return !(await this.repository.hasOwner());
  }
}

/**
 * Себе роли не трогают. Иначе владелец разжалует себя одним неверным
 * нажатием, а администратор сам себе выпишет `roles.assign`.
 */
function ensureNotSelf(actor: AccountRef, accountId: string, message: string): void {
  if (actor.accountId === accountId) throw new ValidationError(message);
}
