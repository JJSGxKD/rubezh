import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import {
  DisabledError,
  ForbiddenError,
  PayloadTooLargeError,
  RateLimitedError,
} from "../../common/domain-error.js";
import { verifyInitData } from "../telegram/telegram-init-data.js";
import { INGEST_LIMITS, type IngestKind } from "./ingest-limits.js";
import { RateLimiter } from "./rate-limiter.js";

/**
 * Дверь приёмников событий и отчётов (docs/28-diagnostics.md §5.2–§5.3).
 *
 * Это не авторизация: приёмник принимает и без подписи запуска. Проверенная
 * подпись `initData` лишь добавляет к записи Telegram ID — чтобы нельзя было
 * подсунуть отчёт с чужим ID и чтобы на этапе 3 связать историю тестера с
 * аккаунтом. Окно свежести длинное (сутки): тестер играет часами, а сервер в
 * ответ ничего не выдаёт — угроза повтора упирается в лимит на Telegram ID.
 */

const INGEST_KIND = "ingest:kind";

/** Пометить обработчик как приёмник: выключатель, лимиты и личность — по виду. */
export const IngestEndpoint = (kind: IngestKind): MethodDecorator => SetMetadata(INGEST_KIND, kind);

export interface IngestIdentity {
  /** только при проверенной подписи; иначе `null` и запись без Telegram ID */
  platformUserId: string | null;
  ip: string;
}

/** Минимальная форма запроса Fastify — см. domain-error.filter.ts. */
interface IngestRequest {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  ingestIdentity?: IngestIdentity;
}

@Injectable()
export class IngestGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.get<IngestKind | undefined>(INGEST_KIND, context.getHandler());
    // Приёмник без пометки — ошибка разработчика, и закрыт он по умолчанию.
    if (kind === undefined) throw new DisabledError("Приёмник не настроен");
    if (!this.enabled(kind)) throw new DisabledError("Приёмник выключен");

    const request = context.switchToHttp().getRequest<IngestRequest>();
    this.checkOrigin(request);

    const limits = INGEST_LIMITS[kind];
    const length = Number(headerOf(request, "content-length") ?? 0);
    if (length > limits.bodyBytes) throw new PayloadTooLargeError("Тело запроса слишком большое");

    if (!(await this.limiter.consume(limits.ip, request.ip))) {
      throw new RateLimitedError("Слишком много запросов, попробуйте позже");
    }

    request.ingestIdentity = { platformUserId: this.platformUserId(request), ip: request.ip };
    return true;
  }

  private enabled(kind: IngestKind): boolean {
    if (kind === "events") return this.config.ingest.eventsEnabled;
    // Отзывы принимаются, пока есть куда их писать: своего выключателя у формы
    // нет — она и появилась, чтобы игроку было куда сказать.
    if (kind === "feedback") return this.config.databaseUrl !== "";
    return this.config.ingest.reportsEnabled;
  }

  /**
   * `Origin` — слабая, но бесплатная защита от случайных запросов: браузер
   * его не подделывает, а скрипту незачем. Пустой список доменов — машина
   * разработчика, там проверка не нужна.
   */
  private checkOrigin(request: IngestRequest): void {
    if (this.config.allowedOrigins.length === 0) return;
    const origin = headerOf(request, "origin");
    if (origin === undefined || !this.config.allowedOrigins.includes(origin)) {
      throw new ForbiddenError("Запрос не с домена игры");
    }
  }

  private platformUserId(request: IngestRequest): string | null {
    const authorization = headerOf(request, "authorization") ?? "";
    if (!authorization.startsWith("tma ") || this.config.telegram.botToken === "") return null;
    const check = verifyInitData(
      authorization.slice(4),
      this.config.telegram.botToken,
      this.config.ingest.initDataMaxAgeSec,
      Date.now(),
    );
    return check.ok ? check.player.id : null;
  }
}

function headerOf(request: IngestRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Личность, которую положил в запрос гвард. */
export function ingestIdentityOf(request: unknown): IngestIdentity {
  const identity = (request as IngestRequest).ingestIdentity;
  if (identity === undefined) throw new DisabledError("Приёмник не настроен");
  return identity;
}
