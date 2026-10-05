import { randomUUID } from "node:crypto";
import type { MessagePreparer, PreparedMessage, PreparedMessageInput } from "../ports/prepared-message.js";
import type { TelegramBotApi } from "./telegram-bot-api.js";

export type PreparerBotApi = Pick<TelegramBotApi, "savePreparedInlineMessage">;

/** Telegram ID — число; у аккаунта разработчика (`dev-…`) Telegram сообщение не подготовит. */
const TELEGRAM_USER_ID = /^\d{1,20}$/;

/**
 * Подготовленное сообщение Telegram (порт `MessagePreparer`): статья с текстом
 * и кнопкой-ссылкой. Отправить её в личку, группу или канал игрок может из
 * Mini App через `shareMessage`; в чат с ботами — нет: там приглашение никому.
 */
export class TelegramMessagePreparer implements MessagePreparer {
  readonly platform = "telegram" as const;

  constructor(
    private readonly api: PreparerBotApi,
    readonly configured: boolean,
  ) {}

  async prepare(platformUserId: string, message: PreparedMessageInput): Promise<PreparedMessage | null> {
    if (!TELEGRAM_USER_ID.test(platformUserId)) return null;
    return await this.api.savePreparedInlineMessage(Number(platformUserId), {
      id: randomUUID(),
      title: message.title,
      description: message.description,
      text: message.text,
      button: { text: message.button.text, url: message.button.url },
    });
  }
}
