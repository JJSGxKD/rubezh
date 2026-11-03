import type { ChatTarget } from "../ports/chat-target.js";
import type { Messenger, OutgoingMessage, SendOutcome } from "../ports/messenger.js";
import { TelegramApiError, type InlineButton, type TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Сообщения от бота Telegram (порт `Messenger`). Здесь — всё, что знает о
 * Telegram: какие коды значат «игрок заблокировал бота», а какие — «подожди».
 *
 * Темп — 25 сообщений в секунду: Telegram ориентирует порядка 30 на массовой
 * отправке без платных рассылок, запас — на уведомления, которые идут
 * параллельно (docs/29-admin-panel.md §7.3).
 */

export type MessengerBotApi = Pick<TelegramBotApi, "sendMessage">;

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

  constructor(
    private readonly api: MessengerBotApi,
    readonly configured: boolean,
  ) {}

  async send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome> {
    if (!TELEGRAM_USER_ID.test(platformUserId)) return { status: "failed", reason: "not_telegram_user" };
    // Напоминание без выхода слать нельзя: сообщение с битой кнопкой действия не уходит вовсе.
    if (message.action !== undefined && Buffer.byteLength(message.action.data, "utf8") > CALLBACK_DATA_MAX_BYTES) return { status: "failed", reason: "bad_action" };
    const rows: InlineButton[][] = [];
    if (message.button !== null) rows.push([{ text: message.button.text, url: message.button.url }]);
    if (message.action !== undefined) rows.push([{ text: message.action.text, callback_data: message.action.data }]);
    return await this.deliver(() => this.api.sendMessage(platformUserId, message.text, undefined, rows.length === 0 ? {} : { keyboard: rows }));
  }

  async sendToChat(target: ChatTarget, text: string): Promise<SendOutcome> {
    return await this.deliver(() => this.api.sendMessage(target, text, undefined, {}));
  }

  /** Ответы Telegram на отправку — в исходы порта: общие для игрока и чата команды. */
  private async deliver(call: () => Promise<unknown>): Promise<SendOutcome> {
    try {
      await call();
      return { status: "sent" };
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      if (error.errorCode === 403) return { status: "blocked" };
      if (error.errorCode === 429) return { status: "retry", afterSec: error.retryAfterSec ?? NETWORK_RETRY_SEC };
      if (error.errorCode === 0 || error.errorCode >= 500) return { status: "retry", afterSec: NETWORK_RETRY_SEC };
      if (error.errorCode === 400 && NO_CHAT.test(error.message)) return { status: "blocked" };
      return { status: "failed", reason: String(error.errorCode) };
    }
  }
}
