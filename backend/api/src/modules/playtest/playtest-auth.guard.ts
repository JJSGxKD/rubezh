import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DisabledError, UnauthorizedError } from "../../common/domain-error";
import { verifyInitData, type TelegramPlayer } from "./telegram-init-data";

/** Минимальная форма запроса вместо типов express — см. domain-error.filter.ts. */
interface HttpRequest {
  header(name: string): string | undefined;
  playtestPlayer?: TelegramPlayer;
}

/**
 * Кто прислал запрос. Игрок — это пользователь Telegram, чья подпись
 * `initData` сошлась с токеном бота: без сложной авторизации, но и без веры
 * клиенту на слово (docs/26-stage2-plan.md, Р19).
 *
 * Данные запуска приходят заголовком `Authorization: tma <initData>`.
 * Для разработки в обычном браузере — заголовок `X-Playtest-Dev-User:
 * id:имя`, который принимается только при `PLAYTEST_DEV_AUTH=true`, а тот —
 * только в development (см. app-config.ts).
 */
@Injectable()
export class PlaytestAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.playtest.enabled) {
      // 404, а не 403: выключенный эндпоинт не подтверждает, что он есть.
      throw new DisabledError("Сохранения плейтеста выключены");
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    request.playtestPlayer = this.identify(request);
    return true;
  }

  private identify(request: HttpRequest): TelegramPlayer {
    const authorization = request.header("authorization") ?? "";
    if (authorization.startsWith("tma ")) {
      const check = verifyInitData(
        authorization.slice(4),
        this.config.playtest.botToken,
        this.config.playtest.initDataMaxAgeSec,
        Date.now(),
      );
      if (check.ok) return check.player;
      throw new UnauthorizedError(
        check.reason === "expired"
          ? "Данные запуска устарели — откройте игру заново"
          : "Данные запуска Telegram не прошли проверку",
      );
    }

    const devUser = request.header("x-playtest-dev-user");
    if (this.config.playtest.devAuth && devUser !== undefined) {
      const [id, ...name] = devUser.split(":");
      if (id !== undefined && /^dev-[a-z0-9-]{1,32}$/.test(id)) {
        return { id, name: name.join(":").slice(0, 64) || "Разработчик", username: null, photoUrl: null };
      }
    }

    throw new UnauthorizedError("Откройте игру в Telegram, чтобы сохранять забеги");
  }
}

/** Игрок, которого положил в запрос guard. */
export function playerOf(request: unknown): TelegramPlayer {
  const player = (request as HttpRequest).playtestPlayer;
  if (player === undefined) throw new UnauthorizedError("Игрок не определён");
  return player;
}
