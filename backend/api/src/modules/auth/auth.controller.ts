import { Body, Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { AUTH_LIMITS } from "./auth-limits.js";
import { AuthGuard, accountOf } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { refreshSchema, telegramLoginSchema } from "./dto/auth.dto.js";

/**
 * Вход, продление и выход (docs/34-stage3-plan.md, WP1). В контроллере нет
 * логики — только разбор границы и форма ответа
 * (docs/15-engineering-standards.md §2.3).
 *
 * Токены в теле ответа, а не в cookie: Mini App ходит в API с другого
 * origin, а хранит токен продления в памяти вкладки — очистку хранилища
 * WebView это переживает (docs/33-telegram-mini-app-pitfalls.md §1.3).
 */

/** Что клиент знает об аккаунте: показать в профиле, и ничего больше. */
export interface AccountView {
  accountId: string;
  displayName: string;
  photoUrl: string | null;
  createdAt: string;
}

interface SessionView {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string;
  account: AccountView;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("telegram")
  async telegram(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SessionView }> {
    this.ensureEnabled();
    await this.limit(AUTH_LIMITS.login, request);

    const { initData } = parse(() => telegramLoginSchema.parse(body), "Некорректные данные запуска");
    return { data: view(await this.service.loginWithTelegram(initData)) };
  }

  @Post("refresh")
  async refresh(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SessionView }> {
    this.ensureEnabled();
    await this.limit(AUTH_LIMITS.refresh, request);

    const { refreshToken } = parse(() => refreshSchema.parse(body), "Некорректный токен продления");
    return { data: view(await this.service.refreshSession(refreshToken)) };
  }

  @Post("logout")
  async logout(@Body() body: unknown): Promise<{ data: { loggedOut: true } }> {
    this.ensureEnabled();

    const { refreshToken } = parse(() => refreshSchema.parse(body), "Некорректный токен продления");
    await this.service.logout(refreshToken);
    return { data: { loggedOut: true } };
  }

  @Post("logout-all")
  @UseGuards(AuthGuard)
  async logoutAll(@Req() request: unknown): Promise<{ data: { sessions: number } }> {
    return { data: { sessions: await this.service.logoutEverywhere(accountOf(request).accountId) } };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@Req() request: unknown): { data: { accountId: string; platform: string } } {
    const account = accountOf(request);
    return { data: { accountId: account.accountId, platform: account.platform } };
  }

  /** Выключенная авторизация отвечает 404 — как приёмники и плейтест. */
  private ensureEnabled(): void {
    if (!this.config.auth.enabled) throw new DisabledError("Авторизация выключена");
  }

  /**
   * Лимит на вход и продление — по адресу запроса. Без него подбор чужого
   * токена продления упирается только в скорость сети
   * (docs/13-reuse-from-vpnsibcom.md §4).
   */
  private async limit(rule: RateLimit, request: unknown): Promise<void> {
    const allowed = await this.limiter.consume(rule, addressOf(request));
    if (!allowed) throw new RateLimitedError("Слишком часто — подождите минуту");
  }
}

function view(result: { accessToken: string; expiresInSec: number; refreshToken: string; account: { accountId: string; displayName: string; photoUrl: string | null; createdAt: Date } }): SessionView {
  return {
    accessToken: result.accessToken,
    expiresInSec: result.expiresInSec,
    refreshToken: result.refreshToken,
    account: {
      accountId: result.account.accountId,
      displayName: result.account.displayName,
      photoUrl: result.account.photoUrl,
      createdAt: result.account.createdAt.toISOString(),
    },
  };
}

/** Адрес из `req.ip` Fastify: он учитывает число доверенных прокси, а сырой заголовок подделывается одной строкой. */
function addressOf(request: unknown): string {
  const ip = (request as { ip?: unknown }).ip;
  return typeof ip === "string" && ip !== "" ? ip : "unknown";
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
