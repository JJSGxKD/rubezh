import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import { BotIdentity } from "./bot-identity.js";
import { TelegramApiError, type InlineButton, type TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "./telegram-bot-api.js";
import { displayName, welcomeCacheKey, type WelcomeCard, type WelcomeProgress } from "./welcome-card.js";
import { languageOf, WELCOME_TEXTS, type WelcomeLanguage } from "./welcome-texts.js";
import { BOT_PROFILE_TEXTS, DEFAULT_PROFILE_LANGUAGE } from "./bot-profile-texts.js";
import { AuthService } from "../../modules/auth/auth.service.js";
import type { TelegramUser } from "./telegram-bot-api.js";

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

export type WelcomeBotApi = Pick<TelegramBotApi, "sendPhoto" | "sendMessage" | "setMenuWebApp">;
export type WelcomeRenderer = (card: WelcomeCard) => Buffer;
export const WELCOME_RENDERER = Symbol("WELCOME_RENDERER");

@Injectable()
export class StartCommand implements BotUpdateHandler, OnModuleInit, OnModuleDestroy {
  readonly name = "start";
  readonly commands = [{ command: "start", description: "Открыть игру", descriptionEn: "Open the game", audience: "everyone" as const }];
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
    private readonly identity: BotIdentity,
    private readonly auth: AuthService,
  ) {}

  onModuleInit(): void {
    if (this.config.telegram.updates !== "off") this.router.register(this);
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    if (message?.text === undefined || message.from === undefined || message.from.is_bot) return false;
    if (!/^\/start(@\w+)?(\s|$)/.test(message.text)) return false;

    const chatId = String(message.chat.id);
    // В группе персональная карточка никому не нужна, а кнопка Mini App там не
    // работает — короткий ответ со ссылкой на бота. Молчать нельзя: команду
    // набирают и в чате теста.
    if (message.chat.type !== "private") {
      await this.api.sendMessage(
        { chatId, threadId: message.message_thread_id ?? null },
        WELCOME_TEXTS.ru.groupHint,
        this.stop.signal,
        this.groupKeyboard(),
      );
      return true;
    }

    // Вход в канал — раньше окна повтора: второй `/start` по новой ссылке —
    // это новое касание, а повтор в том же окне отсекает атрибуция сама.
    await this.enter(message.from, message.text);
    if (!(await this.claim(chatId))) return true;

    const language = languageOf(message.from.language_code);
    const card: WelcomeCard = {
      language,
      name: displayName(message.from.first_name, language),
      progress: (await this.progressOf(String(message.from.id))) ?? { best: null, runs: 0 },
    };
    await this.send(chatId, card, String(message.from.id));
    await this.localizeMenu(chatId, language);
    return true;
  }

  /**
   * Надпись кнопки меню на языке игрока. У кнопки нет языка в Bot API, и по
   * умолчанию она русская (bot-profile.ts) — остальным её ставим на их чат.
   * Не вышло — не беда: кнопка работает и с русской надписью.
   */
  private async localizeMenu(chatId: string, language: WelcomeLanguage): Promise<void> {
    const url = this.config.telegram.webAppUrl;
    if (language === DEFAULT_PROFILE_LANGUAGE || url === "") return;
    try {
      await this.api.setMenuWebApp(BOT_PROFILE_TEXTS[language].menuButton, url, chatId, this.stop.signal);
    } catch (error: unknown) {
      this.log("warn", "menu_not_localized", { reason: reasonOf(error) });
    }
  }

  /**
   * `/start` в личке — вход в канал площадки (docs/35-stage4-plan.md, Р29):
   * аккаунт заводится сразу, параметр ссылки `t.me/<бот>?start=…` становится
   * касанием. Не вышло — карточка всё равно уходит: ответ игроку важнее
   * записи, а следующий вход её догонит.
   */
  private async enter(from: TelegramUser, text: string): Promise<void> {
    if (!this.config.auth.enabled) return;
    try {
      await this.auth.enterChannel({
        platform: "telegram",
        platformUserId: String(from.id),
        displayName: telegramName(from),
        username: from.username ?? null,
        startParam: text.trim().split(/\s+/)[1] ?? null,
      });
    } catch (error: unknown) {
      this.log("warn", "entry_lost", { reason: reasonOf(error) });
    }
  }

  private async send(chatId: string, card: WelcomeCard, userId: string): Promise<void> {
    const texts = WELCOME_TEXTS[card.language];
    const caption = texts.caption(card.name, card.progress.best !== null);
    const keyboard = this.keyboard(card, userId);
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

  private keyboard(card: WelcomeCard, userId: string): InlineButton[][] {
    const rows: InlineButton[][] = [];
    const play = this.playButton(WELCOME_TEXTS[card.language].playButton);
    // Кнопка игры — у всех, включая администраторов: у них она пропадала,
    // когда адрес Mini App не HTTPS, и оставалась одна выгрузка.
    if (play !== null) rows.push([play]);
    // Администратору — вход в выгрузку. Кнопка лишь удобство: право проверяет
    // обработчик нажатия (docs/28-diagnostics.md §6.1.4).
    if (this.config.export.botEnabled && this.config.adminTelegramIds.has(userId)) {
      rows.push([{ text: "📦 Выгрузка данных", callback_data: "export:menu" }]);
    }
    return rows;
  }

  /**
   * Кнопка запуска игры. `web_app` принимает только HTTPS, поэтому на машине
   * разработчика с `http://localhost` она заменяется ссылкой на Mini App
   * через самого бота — её Telegram открывает на любом адресе.
   */
  private playButton(text: string): InlineButton | null {
    const url = this.config.telegram.webAppUrl;
    if (url.startsWith("https://")) return { text, web_app: { url } };
    const link = this.identity.miniAppLink;
    return link === null ? null : { text, url: link };
  }

  private groupKeyboard(): { keyboard?: InlineButton[][] } {
    const play = this.playButton(WELCOME_TEXTS.ru.playButton);
    // В группе `web_app` не работает даже с HTTPS: только ссылка на бота.
    const link = this.identity.miniAppLink;
    if (link !== null) return { keyboard: [[{ text: WELCOME_TEXTS.ru.playButton, url: link }]] };
    return play !== null && "url" in play ? { keyboard: [[play]] } : {};
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

/** Имя игрока для аккаунта — так же, как из подписи запуска: имя и фамилия, иначе юзернейм. */
function telegramName(user: TelegramUser): string {
  const name = [user.first_name, user.last_name].filter((part) => part !== undefined && part !== "").join(" ");
  return name === "" ? (user.username ?? "Игрок") : name;
}
