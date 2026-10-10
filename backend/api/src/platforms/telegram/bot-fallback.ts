import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { BotIdentity } from "./bot-identity.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import { TELEGRAM_BOT_API, type TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";
import { playButtonFor } from "./welcome.command.js";
import { languageOf, WELCOME_TEXTS, type WelcomeLanguage } from "./welcome-texts.js";

/**
 * Ответ на обычное сообщение в личном чате (docs/28-diagnostics.md §6.1.2):
 * бот переписку не читает, но человек, который написал и не получил ответа,
 * уходит с худшим первым впечатлением. Подсказка говорит, куда писать
 * команде, и даёт кнопку «Играть».
 *
 * Обработчик «по умолчанию» маршрутизатора: срабатывает, только если никто из
 * обычных обработчиков обновление не взял. Нет Redis — ответа нет: без
 * счётчика окна бот отвечал бы на каждое сообщение, а молчать безопаснее, чем
 * засыпать человека ответами.
 */

/**
 * Окно на человека: пишущий несколько сообщений подряд получает один ответ, а
 * не по ответу на каждое.
 */
export const FALLBACK_WINDOW_SEC = 600;

export const FALLBACK_TEXTS: Record<WelcomeLanguage, string> = {
  ru: [
    "Я бот игры «Рубеж» и переписку не читаю.",
    "",
    "Вопрос, баг или идея — напишите команде прямо в игре: «Настройки» → «Написать разработчикам». Новости разработки — в канале @KennixDev.",
  ].join("\n"),
  en: [
    "I'm the Rubezh game bot and I don't read messages.",
    "",
    "Questions, bugs or ideas — write to the team right in the game: «Настройки» → «Написать разработчикам» (the game is in Russian for now). Development news — @KennixDev.",
  ].join("\n"),
};

export type FallbackBotApi = Pick<TelegramBotApi, "sendMessage">;

@Injectable()
export class BotFallbackReply implements BotUpdateHandler, OnModuleInit, OnModuleDestroy {
  readonly name = "fallback";
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    private readonly identity: BotIdentity,
    @Inject(TELEGRAM_BOT_API) private readonly api: FallbackBotApi,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    if (this.config.telegram.updates === "off") return;
    this.router.setFallback(this);
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    // Отвечаем только человеку в личке и только на текст: оплата, разрешение
    // писать, стикеры и фото — служебное, группы — чужие разговоры.
    if (message === undefined || typeof message.text !== "string") return true;
    const from = message.from;
    if (from === undefined || from.is_bot || message.chat.type !== "private") return true;

    if (!(await this.claim(from.id))) return true;

    const language = languageOf(from.language_code);
    const button = playButtonFor(this.config.telegram.webAppUrl, this.identity.miniAppLink, WELCOME_TEXTS[language].playButton);
    await this.api.sendMessage(
      { chatId: String(message.chat.id), threadId: null },
      FALLBACK_TEXTS[language],
      this.stop.signal,
      button === null ? {} : { keyboard: [[button]] },
    );
    this.logger.log(JSON.stringify({ module: "bot", event: "fallback_replied", language }));
    return true;
  }

  /** `true` — первое сообщение этого человека в окне. Redis упал — `false`: тишина. */
  private async claim(userId: number): Promise<boolean> {
    try {
      return (await this.redis.set(`bot:fallback:${userId}`, "1", "EX", FALLBACK_WINDOW_SEC, "NX")) !== null;
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({ module: "bot", event: "fallback_window_unavailable", reason: error instanceof Error ? error.message : "unknown" }),
      );
      return false;
    }
  }
}
