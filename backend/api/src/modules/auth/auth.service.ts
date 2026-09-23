import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ForbiddenError, UnauthorizedError } from "../../common/domain-error.js";
import { verifyInitData } from "../telegram/telegram-init-data.js";
import { ACCOUNT_REPOSITORY, type Account, type AccountRepository } from "./account.repository.js";
import { secretKey, signAccessToken } from "./access-token.js";
import { REFRESH_STORE, type RefreshStore } from "./refresh.store.js";

/**
 * Вход и продление сессии (docs/34-stage3-plan.md, WP1).
 *
 * **Почему не по подписи запуска на каждом запросе**, как в плейтесте: строка
 * `initData` не обновляется без перезапуска приложения, а окно её свежести
 * для входа — час (решение Р2): на этой сессии работают деньги. Дальше игрок
 * ходит по своему токену, а токен продления даёт сессии жить дольше часа.
 *
 * **Ротация.** Токен продления одноразовый: использованный гасится, выдаётся
 * новый. Повторное использование погашенного — признак кражи, и тогда
 * сбрасываются все сессии аккаунта: отличить вора от повторившего запрос
 * клиента нельзя, а угнанный аккаунт дороже одного лишнего входа.
 */

export interface AuthTokens {
  accessToken: string;
  /** сколько секунд жив токен доступа — клиент обновляет его заранее */
  expiresInSec: number;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  account: Account;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger("auth");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(REFRESH_STORE) private readonly refresh: RefreshStore,
  ) {}

  /** Вход по подписанным данным запуска Telegram. */
  async loginWithTelegram(initData: string, nowMs = Date.now()): Promise<AuthResult> {
    const check = verifyInitData(initData, this.config.telegram.botToken, this.config.auth.initDataMaxAgeSec, nowMs);
    if (!check.ok) {
      // Причины не раскрываем подробнее, чем нужно клиенту: истекло — открыть
      // заново, остальное — не наш игрок.
      throw new UnauthorizedError(
        check.reason === "expired"
          ? "Данные запуска устарели — откройте игру заново"
          : "Данные запуска Telegram не прошли проверку",
      );
    }

    const account = await this.accounts.upsert(
      {
        platform: "telegram",
        platformUserId: check.player.id,
        displayName: check.player.name,
        username: check.player.username,
        photoUrl: check.player.photoUrl,
      },
      nowMs,
    );
    ensureNotBanned(account);

    const tokens = await this.issue(account, nowMs);
    return { ...tokens, account };
  }

  /** Продление сессии: старый токен гасится, выдаётся новая пара. */
  async refreshSession(refreshToken: string, nowMs = Date.now()): Promise<AuthResult> {
    const hash = hashToken(refreshToken);
    const taken = await this.refresh.take(hash);

    if (taken.status === "reused") {
      await this.refresh.revokeAll(taken.accountId);
      this.logger.warn(`повторное использование токена продления, сессии аккаунта ${taken.accountId} сброшены`);
      throw new UnauthorizedError("Сессия сброшена — войдите заново");
    }
    if (taken.status !== "ok") throw new UnauthorizedError("Сессия не найдена — войдите заново");

    const account = await this.accounts.byId(taken.session.accountId);
    if (account === null) throw new UnauthorizedError("Аккаунт не найден — войдите заново");
    ensureNotBanned(account);

    try {
      const tokens = await this.issue(account, nowMs);
      return { ...tokens, account };
    } catch (error: unknown) {
      // Компенсирующий откат: старый токен уже погашен, а новый не выдался —
      // без возврата игрок остался бы вообще без входа
      // (docs/13-reuse-from-vpnsibcom.md §4).
      await this.refresh.restore(taken.session, hash);
      throw error;
    }
  }

  /** Выход с этого устройства. Неизвестный токен — не ошибка: выйти дважды можно. */
  async logout(refreshToken: string): Promise<void> {
    await this.refresh.take(hashToken(refreshToken));
  }

  /** Выход со всех устройств. */
  async logoutEverywhere(accountId: string): Promise<number> {
    return await this.refresh.revokeAll(accountId);
  }

  private async issue(account: Account, nowMs: number): Promise<AuthTokens> {
    const accessToken = await signAccessToken(
      { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId },
      secretKey(this.config.auth.accessSecret),
      this.config.auth.accessTtlSec,
      nowMs,
    );

    const refreshToken = randomBytes(32).toString("base64url");
    await this.refresh.issue(account.accountId, hashToken(refreshToken), nowMs);

    return { accessToken, expiresInSec: this.config.auth.accessTtlSec, refreshToken };
  }
}

function ensureNotBanned(account: Account): void {
  if (account.bannedAt === null) return;
  throw new ForbiddenError(account.banReason ?? "Аккаунт заблокирован");
}

/**
 * В хранилище уходит только хэш: слепок базы не должен давать рабочих
 * токенов. Соль не нужна — токен и так 256 случайных бит, перебирать нечего.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
