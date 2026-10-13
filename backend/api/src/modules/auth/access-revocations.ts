import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";

/**
 * Отзыв уже выданных токенов доступа: «выйти везде» и блокировка аккаунта.
 *
 * Токен доступа проверяется без обращения к хранилищу, поэтому без этого
 * отзыв токенов продления оставлял бы выданный токен рабочим до его срока.
 * Отзыв — по времени, а не по списку токенов: в Redis пишется секунда отзыва
 * `auth:revoked-before:<аккаунт>`, и не принимается токен, выданный раньше
 * неё. Выданный в ту же секунду проходит: окно меньше секунды, зато вход
 * сразу после «выйти везде» не отклоняется собственным новым токеном.
 *
 * Метка живёт на минуту дольше токена доступа — к этому времени все выданные
 * до отзыва токены уже истекли сами, и хранить её дальше незачем.
 *
 * Недоступный Redis проверку пропускает: без него не работают и токены
 * продления, а отказ всем запросам из-за кеша хуже окна в срок жизни токена.
 */

/** Запас жизни метки сверх срока токена доступа, секунды. */
const MARK_TTL_MARGIN_SEC = 60;
const READ_TIMEOUT_MS = 500;

@Injectable()
export class AccessRevocations {
  private readonly logger = new Logger("auth");

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "get">,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Все токены доступа аккаунта, выданные раньше этой секунды, больше не принимаются. */
  async revokeBefore(accountId: string, nowMs: number): Promise<void> {
    await this.redis.set(markKey(accountId), String(Math.floor(nowMs / 1000)), "EX", this.config.auth.accessTtlSec + MARK_TTL_MARGIN_SEC);
  }

  /** Токен выдан раньше отзыва. Ошибка Redis — `false` и предупреждение в лог. */
  async isRevoked(accountId: string, issuedAtSec: number): Promise<boolean> {
    try {
      const mark = await withTimeout(this.redis.get(markKey(accountId)), READ_TIMEOUT_MS, "проверка отзыва токена");
      if (mark === null) return false;
      const revokedAtSec = Number(mark);
      return Number.isFinite(revokedAtSec) && issuedAtSec < revokedAtSec;
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "auth", event: "revocation_check_failed", reason: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }
}

const markKey = (accountId: string): string => `auth:revoked-before:${accountId}`;
