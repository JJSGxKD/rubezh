import { Body, Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { AUTH_LIMITS } from "./auth-limits.js";
import { AuthGuard, accountOf } from "./auth.guard.js";
import { Public } from "../../common/access.js";
import type { StartKind } from "../attribution/start-param.js";
import type { LoginClient, LoginContext } from "./auth-hooks.js";
import { AuthService } from "./auth.service.js";
import { devLoginSchema, refreshSchema, telegramLoginSchema } from "./dto/auth.dto.js";

/**
 * Вход, продление и выход (docs/34-stage3-plan.md, WP1). Вход, продление и
 * выход открыты по сути: токена у игрока в этот момент ещё нет, а защищают их
 * подпись запуска и лимит частоты. В контроллере нет
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
  /** аккаунт заведён этим входом: по нему клиент шлёт `user_registered` ровно раз */
  created: boolean;
}

interface SessionView {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string;
  account: AccountView;
}

/**
 * Вход на запуске: вдобавок — откуда открыли игру, по проверенной подписи.
 * Клиент кладёт это в событие `session_started`: сам он параметр запуска
 * видит неподписанным.
 */
interface LaunchSessionView extends SessionView {
  launch: { startKind: StartKind };
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post("telegram")
  async telegram(@Req() request: unknown, @Body() body: unknown): Promise<{ data: LaunchSessionView }> {
    this.ensureEnabled();
    await this.limit(AUTH_LIMITS.login, request);

    const { initData, client, reason } = parse(() => telegramLoginSchema.parse(body), "Некорректные данные запуска");
    const result = await this.service.loginWithLaunch("telegram", initData, contextOf(request, client ?? null, reason));
    return { data: { ...view(result), launch: { startKind: result.startParam.kind } } };
  }

  /**
   * Вход разработчика в браузере без Telegram (`AUTH_DEV_LOGIN`). Выключенный
   * отвечает 404, как вся выключенная авторизация.
   */
  @Public()
  @Post("dev")
  async dev(@Req() request: unknown, @Body() body: unknown): Promise<{ data: LaunchSessionView }> {
    this.ensureEnabled();
    if (!this.config.auth.devLogin) throw new DisabledError("Вход разработчика выключен");
    await this.limit(AUTH_LIMITS.login, request);

    const { devUser, reason } = parse(() => devLoginSchema.parse(body), "Некорректный вход разработчика");
    const result = await this.service.loginAsDeveloper(devUser, contextOf(request, null, reason));
    return { data: { ...view(result), launch: { startKind: result.startParam.kind } } };
  }

  @Public()
  @Post("refresh")
  async refresh(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SessionView }> {
    this.ensureEnabled();
    await this.limit(AUTH_LIMITS.refresh, request);

    const { refreshToken } = parse(() => refreshSchema.parse(body), "Некорректный токен продления");
    return { data: view(await this.service.refreshSession(refreshToken)) };
  }

  @Public()
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

function view(result: { accessToken: string; expiresInSec: number; refreshToken: string; account: { accountId: string; displayName: string; photoUrl: string | null; createdAt: Date; created: boolean } }): SessionView {
  return {
    accessToken: result.accessToken,
    expiresInSec: result.expiresInSec,
    refreshToken: result.refreshToken,
    account: {
      accountId: result.account.accountId,
      displayName: result.account.displayName,
      photoUrl: result.account.photoUrl,
      createdAt: result.account.createdAt.toISOString(),
      created: result.account.created,
    },
  };
}

/** Обстоятельства входа для слушателей: адрес, клиент и зачем вход. */
function contextOf(request: unknown, client: LoginClient | null, reason: LoginContext["reason"]): LoginContext {
  const agent = (request as { headers?: Record<string, unknown> }).headers?.["user-agent"];
  const address = addressOf(request);
  return {
    ip: address === "unknown" ? null : address,
    // Строка UA не хранится — по ней лишь уточняется ОС; длиннее и не бывает у честных клиентов.
    userAgent: typeof agent === "string" ? agent.slice(0, 512) : null,
    client,
    reason,
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
