import type { Api } from "grammy";
import type { InputRichMessage } from "grammy/types";
import { z } from "zod";
import { chatTargetOf, type ChatRef } from "../ports/chat-target.js";
import { callBotApi, chatFields, ephemeralFields, type Ephemeral } from "./telegram-api-call.js";
import type { InlineButton } from "./telegram-bot-api.js";

/**
 * Оформленные сообщения Bot API 10.x (Р199) и темы: через клиент grammY, ответы
 * по-прежнему разбираются схемами — типы библиотеки не проверка.
 *
 * Тело оформленного сообщения — тип grammY: остальные файлы адаптера берут его
 * отсюда, а не из библиотеки напрямую.
 */
export type TelegramRichMessage = InputRichMessage;

export interface RichSendOptions {
  keyboard?: InlineButton[][];
  /** без звука уведомления */
  silent?: boolean;
  /** эфемерное сообщение: видно одному игроку */
  ephemeral?: Ephemeral;
}

/** Цвета значка темы, которые разрешает Telegram. */
export type TopicColor = 0x6fb9f0 | 0xffd67e | 0xcb86db | 0x8eee98 | 0xff93b2 | 0xfb6f5f;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOPIC_NAME_CHARS = 128;

const sentMessageSchema = z.object({ message_id: z.number().int() });
const topicSchema = z.object({ message_thread_id: z.number().int() });

export class TelegramRichApi {
  constructor(private readonly api: Api) {}

  /** Отправить оформленное сообщение; результат — его номер. */
  async sendRichMessage(chat: ChatRef, message: TelegramRichMessage, options: RichSendOptions = {}, signal?: AbortSignal): Promise<number> {
    const { chat_id, ...thread } = chatFields(chat);
    const result = await callBotApi("sendRichMessage", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.sendRichMessage(
        chat_id,
        message,
        {
          ...thread,
          ...(options.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.keyboard } }),
          ...(options.silent === undefined ? {} : { disable_notification: options.silent }),
          ...(options.ephemeral === undefined ? {} : { ephemeral_message_parameters: ephemeralFields(options.ephemeral) }),
        },
        abort,
      ),
    );
    return sentMessageSchema.parse(result).message_id;
  }

  /** Заменить содержимое оформленного сообщения. */
  async editRichMessage(chat: ChatRef, messageId: number, message: TelegramRichMessage, signal?: AbortSignal): Promise<void> {
    await callBotApi("editMessageText", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.editMessageText(chatTargetOf(chat).chatId, messageId, message, undefined, abort),
    );
  }

  /** Тема в личном чате с игроком или в супергруппе. */
  async createForumTopic(chatId: number, name: string, iconColor: TopicColor, signal?: AbortSignal): Promise<{ threadId: number }> {
    if (name.length < 1 || name.length > MAX_TOPIC_NAME_CHARS) {
      throw new RangeError(`Тема: имя от 1 до ${String(MAX_TOPIC_NAME_CHARS)} знаков, сейчас ${String(name.length)}`);
    }
    const result = await callBotApi("createForumTopic", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.createForumTopic(chatId, name, { icon_color: iconColor }, abort),
    );
    return { threadId: topicSchema.parse(result).message_thread_id };
  }
}
