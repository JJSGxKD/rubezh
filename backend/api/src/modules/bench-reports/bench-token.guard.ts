import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DisabledError, RateLimitedError, UnauthorizedError } from "../../common/domain-error";

/** Минимальная форма запроса вместо типов express — см. domain-error.filter.ts. */
interface HttpRequest {
  ip?: string;
  header(name: string): string | undefined;
}

/** Сколько запросов с одного адреса пропускаем в окно. */
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

/**
 * Доступ к приёмнику отчётов.
 *
 * Токен лежит в клиентском бандле стенда и потому не является секретом — он
 * отсекает случайных сканеров, наткнувшихся на туннель. Настоящая защита в
 * другом: эндпоинт выключен по умолчанию и включается только на время
 * испытаний (docs/25-week1-fps-trials.md §2).
 *
 * Ограничение частоты сделано в памяти процесса — этого достаточно для
 * одного dev-инстанса. Для продовых эндпоинтов так делать нельзя: счётчик
 * обязан быть атомарным в Redis, иначе при нескольких репликах лимит
 * не соблюдается (docs/13-reuse-from-vpnsibcom.md §2.2).
 */
@Injectable()
export class BenchTokenGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.bench.enabled) {
      // Именно 404, а не 403: выключенный эндпоинт не должен подтверждать
      // сканеру, что он вообще существует.
      throw new DisabledError("Приём отчётов испытаний выключен");
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    this.enforceRateLimit(request.ip ?? "unknown");

    const token = request.header("x-bench-token") ?? "";
    if (token !== this.config.bench.token) {
      throw new UnauthorizedError("Неверный токен приёмника отчётов");
    }

    return true;
  }

  private enforceRateLimit(key: string): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);

    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      this.hits.set(key, recent);
      throw new RateLimitedError("Слишком много запросов, попробуйте позже");
    }

    recent.push(now);
    this.hits.set(key, recent);
  }
}
