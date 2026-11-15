import { Logger } from "@nestjs/common";
import type { ChatTarget } from "../ports/chat-target.js";
import type { Messenger, OutgoingMessage, SendOutcome } from "../ports/messenger.js";
import { TelegramApiError, type InlineButton, type SendOptions, type TelegramBotApi } from "./telegram-bot-api.js";
import { toTelegramRich } from "./telegram-rich-render.js";

/**
 * Сообщения от бота Telegram (порт `Messenger`). Здесь — всё, что знает о
 * Telegram: какие коды значат «игрок заблокировал бота», а какие — «подожди».
 *
 * Темп — 25 сообщений в секунду: Telegram ориентирует порядка 30 на массовой
 * отправке без платных рассылок, запас — на уведомления, которые идут
 * параллельно (docs/29-admin-panel.md §7.3).
 */

/**
 * `rich` необязательный: адаптер, собранный без него (фейки тестов и сборки до
 * Bot API 10.x), шлёт оформленное простым текстом, как при отказе площадки.
 */
export type MessengerBotApi = Pick<TelegramBotApi, "sendMessage"> & Partial<Pick<TelegramBotApi, "rich">>;

/**
 * Сколько процесс после отказа на оформленном сообщении шлёт простой текст
 * сразу, не пробуя `sendRichMessage` (Р225): Telegram мог отключить метод
 * целиком, и каждое сообщение платило бы лишним запросом и отказом.
 */
export const RICH_RETRY_MS = 30 * 60_000;

/** Часы и вывод предупреждений — подменяются в тестах. */
export interface TelegramMessengerEnvironment {
  now(): number;
  warn(line: Record<string, unknown>): void;
}

const logger = new Logger("bot");

const REAL_ENVIRONMENT: TelegramMessengerEnvironment = {
  now: () => Date.now(),
  warn: (line) => logger.warn(JSON.stringify(line)),
};

/** Telegram ID — число; у аккаунта разработчика (`dev-…`) чата с ботом нет. */
const TELEGRAM_USER_ID = /^\d{1,20}$/;

/** Эти 400 значат то же, что блокировка: чата с игроком нет и не будет. */
const NO_CHAT = /chat not found|user is deactivated|bot can't initiate conversation/i;

/** Сбой связи или сервера Telegram без `retry_after` — пауза перед повтором. */
const NETWORK_RETRY_SEC = 5;

/** Предел `callback_data` у Telegram — 64 байта; длиннее он отвечает 400 `BUTTON_DATA_INVALID`. */
const CALLBACK_DATA_MAX_BYTES = 64;

export class TelegramMessenger implements Messenger {
  readonly platform = "telegram" as const;
  readonly ratePerSec = 25;
  /** оформление есть, если собран метод `sendRichMessage`; тем в личке пока нет (WP52 № 14) */
  readonly capabilities: { rich: boolean; topics: boolean };
  /** до этого момента оформленное сразу уходит простым текстом; 0 — метод можно пробовать */
  private richPausedUntil = 0;

  constructor(
    private readonly api: MessengerBotApi,
    readonly configured: boolean,
    private readonly environment: TelegramMessengerEnvironment = REAL_ENVIRONMENT,
  ) {
    this.capabilities = { rich: api.rich !== undefined, topics: false };
  }

  async send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome> {
    if (!TELEGRAM_USER_ID.test(platformUserId)) return { status: "failed", reason: "not_telegram_user" };
    // Напоминание без выхода слать нельзя: сообщение с битой кнопкой действия не уходит вовсе.
    if (message.action !== undefined && Buffer.byteLength(message.action.data, "utf8") > CALLBACK_DATA_MAX_BYTES) return { status: "failed", reason: "bad_action" };
    const rows: InlineButton[][] = [];
    if (message.button !== null) rows.push([{ text: message.button.text, url: message.button.url }]);
    if (message.action !== undefined) rows.push([{ text: message.action.text, callback_data: message.action.data }]);
    const options: SendOptions = { ...(rows.length === 0 ? {} : { keyboard: rows }), ...(message.silent === undefined ? {} : { silent: message.silent }) };
    if (message.rich === undefined) return await this.deliver(() => this.api.sendMessage(platformUserId, message.text, undefined, options));
    return await this.sendRich(platformUserId, message.text, message.rich, options);
  }

  async sendToChat(target: ChatTarget, text: string): Promise<SendOutcome> {
    return await this.deliver(() => this.api.sendMessage(target, text, undefined, {}));
  }

  /**
   * Оформленное сообщение. Отказ метода (400 не про чат, 404) — тот же документ
   * простым текстом с той же клавиатурой и пауза: следующие `RICH_RETRY_MS`
   * процесс шлёт простой текст сразу. 403, 429 и сбой сети — как у обычного
   * сообщения, запасной текст тут не поможет.
   */
  private async sendRich(platformUserId: string, plainText: string, rich: NonNullable<OutgoingMessage["rich"]>, options: SendOptions): Promise<SendOutcome> {
    const sendPlain = async (): Promise<SendOutcome> => {
      const outcome = await this.deliver(() => this.api.sendMessage(platformUserId, plainText, undefined, options));
      return outcome.status === "sent" ? { status: "sent", fallback: true } : outcome;
    };
    const api = this.api.rich;
    if (api === undefined || this.environment.now() < this.richPausedUntil) return await sendPlain();
    try {
      await api.sendRichMessage(platformUserId, toTelegramRich(rich), options);
      return { status: "sent" };
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      if (!isRichRefusal(error)) return outcomeOf(error);
      this.richPausedUntil = this.environment.now() + RICH_RETRY_MS;
      this.environment.warn({ module: "bot", event: "rich_unavailable", code: error.errorCode });
      return await sendPlain();
    }
  }

  /** Ответы Telegram на отправку — в исходы порта: общие для игрока и чата команды. */
  private async deliver(call: () => Promise<unknown>): Promise<SendOutcome> {
    try {
      await call();
      return { status: "sent" };
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      return outcomeOf(error);
    }
  }
}

function outcomeOf(error: TelegramApiError): SendOutcome {
  if (error.errorCode === 403) return { status: "blocked" };
  if (error.errorCode === 429) return { status: "retry", afterSec: error.retryAfterSec ?? NETWORK_RETRY_SEC };
  if (error.errorCode === 0 || error.errorCode >= 500) return { status: "retry", afterSec: NETWORK_RETRY_SEC };
  if (error.errorCode === 400 && NO_CHAT.test(error.message)) return { status: "blocked" };
  return { status: "failed", reason: String(error.errorCode) };
}

/** Площадка отказала именно оформленному сообщению: 404 на метод или 400 не про чат (Р199, Р225). */
function isRichRefusal(error: TelegramApiError): boolean {
  return error.errorCode === 404 || (error.errorCode === 400 && !NO_CHAT.test(error.message));
}
