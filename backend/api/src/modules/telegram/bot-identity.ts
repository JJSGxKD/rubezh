import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Имя бота — для ссылки на Mini App `https://t.me/<бот>?startapp`. Она нужна
 * там, где кнопка `web_app` не работает: у неё адрес обязан быть HTTPS, а на
 * машине разработчика он `http://localhost` (docs/20-env-and-ports.md §4).
 *
 * Спрашивается один раз на старте: имя бота не меняется на ходу, а токен уже
 * есть — отдельной переменной окружения для этого не нужно.
 */
export type IdentityBotApi = Pick<TelegramBotApi, "getMe">;

@Injectable()
export class BotIdentity implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();
  private botUsername: string | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TELEGRAM_BOT_API) private readonly api: IdentityBotApi,
  ) {}

  /** `null` — имя ещё не узнали или бот выключен. */
  get username(): string | null {
    return this.botUsername;
  }

  /** Ссылка на Mini App через бота; `null` — имя бота неизвестно. */
  get miniAppLink(): string | null {
    return this.botUsername === null ? null : `https://t.me/${this.botUsername}?startapp`;
  }

  onApplicationBootstrap(): void {
    void this.refresh();
  }

  /** Спросить имя бота. Отдельно от старта — чтобы тесты его дожидались. */
  async refresh(): Promise<void> {
    if (this.config.telegram.updates === "off" || this.config.telegram.botToken === "") return;
    await this.api
      .getMe(this.stop.signal)
      .then((me) => {
        this.botUsername = me.username;
        this.logger.log(JSON.stringify({ module: "bot", event: "identity", username: me.username }));
      })
      .catch((error: unknown) => {
        // Без имени бот работает: кнопка игры просто уйдёт адресом Mini App.
        this.logger.warn(
          JSON.stringify({ module: "bot", event: "identity_unknown", reason: error instanceof Error ? error.message : "unknown" }),
        );
      });
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }
}
