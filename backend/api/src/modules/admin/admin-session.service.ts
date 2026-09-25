import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, ForbiddenError, UnauthorizedError, ValidationError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type Account, type AccountRepository } from "../auth/account.repository.js";
import { parseDevUser } from "../auth/dev-login.js";
import { permissionsOf, type Permission, type Role } from "../roles/permissions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PanelAccessError } from "./admin-errors.js";
import { ADMIN_SESSION_STORE, hashSessionToken, type AdminSession, type AdminSessionStore } from "./admin-session.store.js";

/**
 * Сессии панели (docs/29-admin-panel.md §4, §8): вход, проверка на каждом
 * запросе, выход. Вход пока один — разработчика на своей машине; вход через
 * виджет Telegram придёт вместе с доменом отдельной задачей
 * (docs/36-parallel-work.md §1.2): проверка подписи виджета — дело адаптера
 * площадки, а не домена.
 *
 * Роли в сессию не кладутся и перечитываются на каждом запросе — так же, как
 * у игры: отзыв роли или блокировка закрывают панель следующим же запросом, а
 * не по истечении срока cookie.
 */

/** Что панель знает о вошедшем: показать в шапке и решить, какие разделы рисовать. Решает всё равно сервер. */
export interface AdminIdentity {
  account: {
    accountId: string;
    platform: Account["platform"];
    displayName: string;
    photoUrl: string | null;
  };
  roles: Role[];
  permissions: Permission[];
}

export interface AdminLogin extends AdminIdentity {
  /** токен в cookie; наружу больше никуда */
  token: string;
  expiresAtMs: number;
}

export interface AuthenticatedSession {
  tokenHash: string;
  session: AdminSession;
  account: AccountRef;
}

@Injectable()
export class AdminSessionService {
  private readonly logger = new Logger("admin");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(ADMIN_SESSION_STORE) private readonly sessions: AdminSessionStore,
    private readonly roles: RolesService,
  ) {}

  /** Выключенная панель отвечает 404 — как приёмники, плейтест и авторизация. */
  ensureEnabled(): void {
    if (!this.config.admin.enabled) throw new DisabledError("Панель выключена");
  }

  /**
   * Вход разработчика — тем же именем `dev-<id>:Имя`, что и в игру, и тот же
   * аккаунт: на машине разработчика он владелец
   * (`roles.service.ts`). Без единой роли в панель не пускаем: панель — не
   * место, куда заходят посмотреть.
   */
  async loginAsDeveloper(devUser: string, nowMs = Date.now()): Promise<AdminLogin> {
    this.ensureEnabled();
    if (!this.config.auth.devLogin) throw new DisabledError("Вход разработчика выключен");
    const developer = parseDevUser(devUser);
    if (developer === null) throw new ValidationError("Вход разработчика — dev-<id>:Имя");

    const account = await this.accounts.upsert(
      { platform: "telegram", platformUserId: developer.platformUserId, displayName: developer.displayName, username: null, photoUrl: null },
      nowMs,
    );
    return await this.open(account, nowMs);
  }

  /**
   * Проверить cookie: сессия есть, не истекла, аккаунт жив и у него всё ещё
   * есть роль. Истёкшая и осиротевшая сессия удаляется, чтобы не лежать до
   * срока в Redis.
   */
  async authenticate(token: string, nowMs = Date.now()): Promise<AuthenticatedSession> {
    this.ensureEnabled();
    if (token === "") throw new UnauthorizedError("Нужен вход в панель");

    const tokenHash = hashSessionToken(token);
    const session = await this.sessions.get(tokenHash);
    if (session === null) throw new UnauthorizedError("Сессия панели не найдена — войдите заново");
    if (session.expiresAtMs <= nowMs) {
      await this.sessions.delete(tokenHash);
      throw new UnauthorizedError("Сессия панели истекла — войдите заново");
    }

    const account = await this.accounts.byId(session.accountId);
    if (account === null || account.bannedAt !== null) {
      await this.sessions.revokeAll(session.accountId);
      throw new PanelAccessError("Аккаунт заблокирован");
    }
    const ref = refOf(account);
    if ((await this.roles.rolesFor(ref)).length === 0) {
      await this.sessions.revokeAll(session.accountId);
      throw new PanelAccessError("Доступа в панель больше нет");
    }
    return { tokenHash, session, account: ref };
  }

  async identity(account: AccountRef): Promise<AdminIdentity> {
    const stored = await this.accounts.byId(account.accountId);
    if (stored === null) throw new UnauthorizedError("Аккаунт не найден");
    return await this.identityOf(stored);
  }

  /** Выйти с этого устройства. Неизвестный токен — не ошибка: выйти дважды можно. */
  async logout(tokenHash: string): Promise<void> {
    await this.sessions.delete(tokenHash);
  }

  /** Отозвать все сессии панели у аккаунта — при блокировке и снятии последней роли. */
  async revokeAll(accountId: string): Promise<number> {
    return await this.sessions.revokeAll(accountId);
  }

  private async open(account: Account, nowMs: number): Promise<AdminLogin> {
    if (account.bannedAt !== null) throw new ForbiddenError(account.banReason ?? "Аккаунт заблокирован");
    const identity = await this.identityOf(account);
    if (identity.roles.length === 0) throw new PanelAccessError("В панель пускают только с ролью");

    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = nowMs + this.config.admin.sessionTtlSec * 1000;
    await this.sessions.put(hashSessionToken(token), {
      accountId: account.accountId,
      platform: account.platform,
      platformUserId: account.platformUserId,
      issuedAtMs: nowMs,
      expiresAtMs,
    });
    // Вход в панель — в журнал: кто и когда открывал инструменты команды,
    // читается вместе с тем, что он там делал.
    await this.roles.audit({ actorAccountId: account.accountId, action: "admin.login", target: account.accountId, after: { roles: identity.roles } });
    this.logger.log(JSON.stringify({ module: "admin", event: "login", accountId: account.accountId, roles: identity.roles }));
    return { ...identity, token, expiresAtMs };
  }

  private async identityOf(account: Account): Promise<AdminIdentity> {
    const roles = await this.roles.rolesFor(refOf(account));
    return {
      account: { accountId: account.accountId, platform: account.platform, displayName: account.displayName, photoUrl: account.photoUrl },
      roles,
      permissions: [...permissionsOf(roles)],
    };
  }
}

function refOf(account: Account): AccountRef {
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}
