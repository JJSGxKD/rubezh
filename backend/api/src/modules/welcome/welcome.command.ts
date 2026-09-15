import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { BotRouter, type BotUpdateHandler } from "../bot/bot-router.js";
import { TelegramApiError, type InlineButton, type TelegramBotApi, type TelegramUpdate } from "../telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../telegram/telegram.module.js";
import { displayName, welcomeCacheKey, type WelcomeCard, type WelcomeProgress } from "./welcome-card.js";
import { languageOf, WELCOME_TEXTS } from "./welcome-texts.js";

/**
 * `/start` у всех (docs/28-diagnostics.md §6.1.2): персональная карточка на
 * языке пользователя и кнопка запуска игры.
 *
 * Карточка рисуется один раз на одинаковое содержимое. После первой отправки
 * Telegram отдаёт `file_id`, и дальше та же картинка уходит по нему — без
 * рендера и без загрузки. Протухший `file_id` — нарисовать и загрузить заново.
 */

/** Сколько помнить `file_id` карточки: Telegram хранит файлы бота долго, а шаблон меняется версией. */
const CARD_CACHE_TTL_SEC = 30 * 24 * 60 * 60;
/** Повторный `/start` в эти секунды — нажатие дважды, а не новая просьба. */
const START_WINDOW_SEC = 3;
/** Прогресс — украшение приветствия: не пришёл за это время — карточка новичка. */
const PROGRESS_TIMEOUT_MS = 2_000;

export interface WelcomeProgressSource {
  progress(playerId: string): Promise<WelcomeProgress | null>;
}

/**
 * Откуда брать рекорд и место. Модуль приветствия не знает про плейтест:
 * источник подключает модуль, у которого есть данные, — так бот работает и
 * там, где плейтеста нет.
 */
@Injectable()
export class WelcomeProgressRegistry {
  source: WelcomeProgressSource | null = null;
}

export interface WelcomeCardCache {
  get(key: string): Promise<string | null>;
  set(key: string, fileId: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** `true` — первый `/start` этого чата в окне */
  claimStart(chatId: string): Promise<boolean>;
}

export const WELCOME_CARD_CACHE = Symbol("WELCOME_CARD_CACHE");

@Injectable()
export class RedisWelcomeCardCache implements WelcomeCardCache {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(`bot:card:${key}`);
  }

  async set(key: string, fileId: string): Promise<void> {
    await this.redis.set(`bot:card:${key}`, fileId, "EX", CARD_CACHE_TTL_SEC);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`bot:card:${key}`);
  }

  async claimStart(chatId: string): Promise<boolean> {
    return (await this.redis.set(`bot:start:${chatId}`, "1", "EX", START_WINDOW_SEC, "NX")) !== null;
  }
}

export type WelcomeBotApi = Pick<TelegramBotApi, "sendPhoto" | "setMyCommands">;
export type WelcomeRenderer = (card: WelcomeCard) => Buffer;
export const WELCOME_RENDERER = Symbol("WELCOME_RENDERER");

@Injectable()
export class StartCommand implements BotUpdateHandler, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly name = "start";
  private readonly logger = new Logger("welcome");
  private readonly stop = new AbortController();
  /** рендер одинаковой карточки, начатый другим `/start`, не повторяется в этом процессе */
  private readonly rendering = new Map<string, Promise<Buffer>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    private readonly registry: WelcomeProgressRegistry,
    @Inject(WELCOME_CARD_CACHE) private readonly cache: WelcomeCardCache,
    @Inject(TELEGRAM_BOT_API) private readonly api: WelcomeBotApi,
    @Inject(WELCOME_RENDERER) private readonly render: WelcomeRenderer,
  ) {}

  onModuleInit(): void {
    if (this.config.telegram.updates !== "off") this.router.register(this);
  }

  onApplicationBootstrap(): void {
    if (this.config.telegram.updates === "off") return;
    // Меню команд для всех, на двух языках: русский клиент видит русское описание.
    for (const language of ["ru", "en"] as const) {
      void this.api
        .setMyCommands(
          [{ command: "start", description: language === "ru" ? "Открыть игру" : "Open the game" }],
          null,
          this.stop.signal,
          language === "ru" ? "ru" : undefined,
        )
        .catch((error: unknown) => this.log("warn", "commands_not_set", { reason: reasonOf(error) }));
    }
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    if (message?.text === undefined || message.from === undefined || message.from.is_bot) return false;
    if (!/^\/start(@\w+)?(\s|$)/.test(message.text)) return false;
    // В группе приветствие с именем никому не нужно, а кнопка Mini App там не работает.
    if (message.chat.type !== "private") return true;

    const chatId = String(message.chat.id);
    if (!(await this.claim(chatId))) return true;

    const language = languageOf(message.from.language_code);
    const card: WelcomeCard = {
      language,
      name: displayName(message.from.first_name, language),
      progress: (await this.progressOf(String(message.from.id))) ?? { best: null, runs: 0 },
    };
    await this.send(chatId, card);
    return true;
  }

  private async send(chatId: string, card: WelcomeCard): Promise<void> {
    const texts = WELCOME_TEXTS[card.language];
    const caption = texts.caption(card.name, card.progress.best !== null);
    const keyboard = this.keyboard(card);
    const options = keyboard.length === 0 ? {} : { keyboard };
    const key = welcomeCacheKey(card);

    const cached = await this.cache.get(key).catch((error: unknown) => {
      this.log("warn", "cache_unavailable", { reason: reasonOf(error) });
      return null;
    });
    if (cached !== null) {
      try {
        await this.api.sendPhoto(chatId, cached, caption, this.stop.signal, options);
        this.log("log", "welcome_sent", { cached: true, language: card.language });
        return;
      } catch (error: unknown) {
        // Telegram больше не знает этот файл — рисуем заново. Иная ошибка
        // (сеть, чат недоступен) повторной загрузкой не лечится.
        if (!(error instanceof TelegramApiError && error.errorCode === 400)) throw error;
        this.log("warn", "cached_file_rejected", { reason: error.message });
        await this.cache
          .delete(key)
          .catch((cacheError: unknown) => this.log("warn", "cache_delete_failed", { reason: reasonOf(cacheError) }));
      }
    }

    const png = await this.renderOnce(key, card);
    const sent = await this.api.sendPhoto(chatId, png, caption, this.stop.signal, options);
    if (sent.fileId !== null) {
      await this.cache
        .set(key, sent.fileId)
        .catch((error: unknown) => this.log("warn", "cache_write_failed", { reason: reasonOf(error) }));
    }
    this.log("log", "welcome_sent", { cached: false, language: card.language, pngBytes: png.length });
  }

  private renderOnce(key: string, card: WelcomeCard): Promise<Buffer> {
    const existing = this.rendering.get(key);
    if (existing !== undefined) return existing;
    const job = Promise.resolve()
      .then(() => this.render(card))
      .finally(() => this.rendering.delete(key));
    this.rendering.set(key, job);
    return job;
  }

  private keyboard(card: WelcomeCard): InlineButton[][] {
    const url = this.config.telegram.webAppUrl;
    // Кнопка Mini App принимает только HTTPS: на машине разработчика без
    // туннеля её нет, и карточка уходит без кнопки.
    return url.startsWith("https://") ? [[{ text: WELCOME_TEXTS[card.language].playButton, web_app: { url } }]] : [];
  }

  private async claim(chatId: string): Promise<boolean> {
    try {
      return await this.cache.claimStart(chatId);
    } catch (error: unknown) {
      this.log("warn", "start_window_unavailable", { reason: reasonOf(error) });
      return true;
    }
  }

  private async progressOf(playerId: string): Promise<WelcomeProgress | null> {
    const source = this.registry.source;
    if (source === null) return null;
    try {
      return await withTimeout(source.progress(playerId), PROGRESS_TIMEOUT_MS, "прогресс игрока");
    } catch (error: unknown) {
      this.log("warn", "progress_unavailable", { reason: reasonOf(error) });
      return null;
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "welcome", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
