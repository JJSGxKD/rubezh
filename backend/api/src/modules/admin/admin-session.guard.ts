import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/access-token.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE, parseCookies } from "./admin-cookie.js";
import { CsrfRejectedError } from "./admin-errors.js";
import { AdminSessionService } from "./admin-session.service.js";

/**
 * Доступ в панель по cookie (docs/29-admin-panel.md §8). Кладёт в запрос тот
 * же `account`, что `AuthGuard` игры, — поэтому `PermissionGuard` и
 * `accountOf()` работают с панелью без правок: право проверяется по аккаунту,
 * а не по способу входа.
 *
 * Изменяющие запросы обязаны нести заголовок панели (`admin-cookie.ts`):
 * `SameSite=Strict` — защита браузера, заголовок — наша, и одна не отменяет
 * другую.
 */

/** Минимальная форма запроса вместо типов Fastify — см. domain-error.filter.ts. */
interface AdminRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  account?: AccessTokenClaims;
  adminSessionHash?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly sessions: AdminSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE) ?? "";
    const authenticated = await this.sessions.authenticate(token);

    if (!SAFE_METHODS.has(request.method.toUpperCase()) && headerValue(request.headers[ADMIN_CSRF_HEADER]) !== ADMIN_CSRF_VALUE) {
      throw new CsrfRejectedError();
    }

    request.account = authenticated.account;
    request.adminSessionHash = authenticated.tokenHash;
    return true;
  }
}

/** Хэш сессии, положенный гвардом, — для выхода. */
export function adminSessionOf(request: unknown): string {
  const hash = (request as AdminRequest).adminSessionHash;
  if (hash === undefined) throw new Error("сессия панели не определена: гвард не стоит на маршруте");
  return hash;
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
