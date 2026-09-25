import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Public } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { clearedSessionCookie, sessionCookie } from "./admin-cookie.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard, adminSessionOf } from "./admin-session.guard.js";
import { AdminSessionService, type AdminIdentity } from "./admin-session.service.js";
import { adminDevLoginSchema } from "./dto/admin.dto.js";

/**
 * Вход в панель и выход (docs/29-admin-panel.md §4, §8). Токен сессии уходит
 * только в cookie: телу ответа он не нужен, а из `HttpOnly` cookie его не
 * прочитает ни скрипт на странице, ни расширение браузера.
 */

/** Ровно то, что нужно от ответа Fastify, — без его типов (см. domain-error.filter.ts). */
interface ReplyHeaders {
  header(name: string, value: string): unknown;
}

@Controller("admin/session")
export class AdminSessionController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Вход разработчика — открыт по сути: сессии в этот момент ещё нет, а
   * защищают его флаг разработки, лимит по адресу и то, что аккаунт без роли
   * в панель не попадёт.
   */
  @Public()
  @Post("dev")
  async dev(@Req() request: unknown, @Body() body: unknown, @Res({ passthrough: true }) reply: ReplyHeaders): Promise<{ data: AdminIdentity }> {
    this.sessions.ensureEnabled();
    await this.limit(ADMIN_LIMITS.login, addressOf(request));

    const { devUser } = parse(() => adminDevLoginSchema.parse(body), "Некорректный вход разработчика");
    const login = await this.sessions.loginAsDeveloper(devUser);
    reply.header("set-cookie", sessionCookie(login.token, this.config.admin.sessionTtlSec, this.secure()));
    return { data: { account: login.account, roles: login.roles, permissions: login.permissions } };
  }

  /** Кто вошёл и что ему открыто — панель рисует разделы по этому ответу, а решает всё равно сервер. */
  @Get()
  @UseGuards(AdminSessionGuard)
  async me(@Req() request: unknown): Promise<{ data: AdminIdentity }> {
    return { data: await this.sessions.identity(accountOf(request)) };
  }

  @Post("logout")
  @UseGuards(AdminSessionGuard)
  async logout(@Req() request: unknown, @Res({ passthrough: true }) reply: ReplyHeaders): Promise<{ data: { loggedOut: true } }> {
    await this.sessions.logout(adminSessionOf(request));
    reply.header("set-cookie", clearedSessionCookie(this.secure()));
    return { data: { loggedOut: true } };
  }

  /** `Secure` снимается только в разработке: там панель открывается по http. */
  private secure(): boolean {
    return this.config.nodeEnv !== "development";
  }

  private async limit(rule: RateLimit, key: string): Promise<void> {
    if (!(await this.limiter.consume(rule, key))) throw new RateLimitedError("Слишком часто — подождите минуту");
  }
}

/** Адрес из `req.ip` Fastify: он учитывает число доверенных прокси, а сырой заголовок подделывается одной строкой. */
function addressOf(request: unknown): string {
  const ip = (request as { ip?: unknown }).ip;
  return typeof ip === "string" && ip !== "" ? ip : "unknown";
}
