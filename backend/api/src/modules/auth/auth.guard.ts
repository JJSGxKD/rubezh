import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, DomainError, UnauthorizedError } from "../../common/domain-error.js";
import { AccessRevocations } from "./access-revocations.js";
import { secretKey, verifyAccessToken, type AccessTokenClaims } from "./access-token.js";

/**
 * Доступ по токену (docs/34-stage3-plan.md, WP1): `Authorization: Bearer …`.
 *
 * Причина отказа типизирована и доходит до клиента кодом ответа, а не
 * схлопывается в один 403 без диагностики, как в источнике переноса
 * (docs/13-reuse-from-vpnsibcom.md §4). Истёкший токен — отдельный код:
 * по нему клиент молча обновляет сессию, а не выбрасывает игрока на вход.
 */

/** Минимальная форма запроса вместо типов Fastify — см. domain-error.filter.ts. */
interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  account?: AccessTokenClaims;
}

/** Отдельный код: по нему клиент обновляет сессию, а не показывает вход. */
export class TokenExpiredError extends DomainError {
  constructor() {
    super("token_expired", "Токен доступа истёк", 401);
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  // Отзыв необязателен: гард собирают вручную десятки тестов других областей,
  // а в приложении его всегда даёт AuthModule.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly revocations?: AccessRevocations,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.auth.enabled) {
      // 404, а не 403: выключенный эндпоинт не подтверждает, что он есть.
      throw new DisabledError("Авторизация выключена");
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token === "") throw new UnauthorizedError("Нужен токен доступа");

    const check = await verifyAccessToken(token, secretKey(this.config.auth.accessSecret), Date.now());
    if (!check.ok) {
      if (check.reason === "expired") throw new TokenExpiredError();
      throw new UnauthorizedError("Токен доступа не принят");
    }

    if (this.revocations !== undefined && (await this.revocations.isRevoked(check.claims.accountId, check.issuedAtSec))) {
      throw new UnauthorizedError("Сессия завершена — войдите заново");
    }

    request.account = check.claims;
    return true;
  }
}

/** Аккаунт, которого положил в запрос guard. */
export function accountOf(request: unknown): AccessTokenClaims {
  const account = (request as HttpRequest).account;
  if (account === undefined) throw new UnauthorizedError("Аккаунт не определён");
  return account;
}
