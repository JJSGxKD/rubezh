import { Api, GrammyError, HttpError, InputFile } from "grammy";
import { z } from "zod";
import { chatFields, chatTargetOf, type ChatRef } from "./chat-target.js";

/**
 * Методы Bot API, которые нужны боту, — поверх клиента grammY
 * (docs/16-tech-stack-decisions.md §5): обновления, сообщения с кнопками,
 * картинки, документы, команды меню, вебхук и оплата в Stars.
 *
 * **grammY — транспорт, а не каркас бота.** Он даёт методы и типы Bot API,
 * которые отслеживают спецификацию, многочастную отправку файлов и разбор
 * ошибок; модули же зависят от этого класса, а не от grammY, и подменяют его
 * в тестах узким срезом (`Pick<TelegramBotApi, …>`). Маршрутизация
 * (`BotRouter`), распределённый лок опроса и вебхук с секретом остаются
 * нашими: у grammY нет лока на несколько процессов.
 *
 * Ответы Telegram — граница системы: то, что мы из них берём, по-прежнему
 * разбирается схемой, типы grammY — не проверка. Токен живёт в URL запроса, и
 * grammY его в ошибки не выносит (`sensitiveLogs` выключен).
 */

/**
 * Токен внедрения клиента. Живёт рядом с самим клиентом, а не в модуле:
 * модуль импортирует провайдеров, и всякий провайдер, которому нужен токен,
 * замкнул бы круг импортов — в ESM это не предупреждение, а падение на старте
 * («Cannot access before initialization»).
 */
export const TELEGRAM_BOT_API = Symbol("TELEGRAM_BOT_API");

/** Запас сверх long polling: Telegram держит запрос до `timeout` секунд и отвечает чуть позже. */
const POLL_GRACE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Документ до 50 МБ по мобильному каналу сервера — ждём дольше обычного запроса. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Какие обновления бот читает: команды и нажатия кнопок. Остальное Telegram не шлёт вовсе. */
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Разметка кнопок под сообщением — в том виде, в каком её ждёт grammY. */
type ReplyMarkup = { reply_markup?: { inline_keyboard: InlineButton[][] } };

/**
 * Сигнал отмены в типах grammY. На Node они описывают его через полифил
 * `abort-controller`, и нативный `AbortSignal` с ним структурно не сходится,
 * хотя grammY лишь передаёт сигнал дальше — в наш нативный `fetch`.
 */
type GrammySignal = NonNullable<Parameters<Api["getMe"]>[0]>;

/** Языки меню команд — те, на которых говорит бот. */
export type CommandsLanguage = "ru" | "en";

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    description: string,
    /** секунды до повтора при `429` */
    readonly retryAfterSec: number | null,
  ) {
    super(`Bot API ${method}: ${errorCode} ${description}`);
    this.name = "TelegramApiError";
  }
}

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(16).optional(),
});

const chatSchema = z.object({ id: z.number().int(), type: z.string() });

export const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      text: z.string().optional(),
      chat: chatSchema,
      /** тема супергруппы, если сообщение пришло из неё — ответ уходит туда же */
      message_thread_id: z.number().int().optional(),
      from: userSchema.optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(128),
      from: userSchema,
      data: z.string().max(64).optional(),
      message: z
        .object({ message_id: z.number().int(), chat: chatSchema, message_thread_id: z.number().int().optional() })
        .optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;
export type TelegramUser = z.infer<typeof userSchema>;

const sentMessageSchema = z.object({
  message_id: z.number().int(),
  photo: z.array(z.object({ file_id: z.string() })).optional(),
});

export interface BotCommand {
  command: string;
  description: string;
}

/** Встроенные кнопки под сообщением: запуск Mini App или нажатие с данными. */
/**
 * Кнопка под сообщением: Mini App (только HTTPS и только в личном чате),
 * обычная ссылка или ответ боту.
 */
export type InlineButton =
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }
  | { text: string; callback_data: string };

export interface SendOptions {
  keyboard?: InlineButton[][];
}

/** Счёт в Telegram Stars: одна позиция, сумма целыми звёздами. */
export interface StarsInvoice {
  /** 1–32 знака: заголовок окна оплаты */
  title: string;
  /** 1–255 знаков */
  description: string;
  /** 1–128 байт; игрок его не видит, он возвращается в проверке и подтверждении оплаты */
  payload: string;
  /** подпись позиции в счёте */
  label: string;
  stars: number;
}

export interface SentPhoto {
  messageId: number;
  /** идентификатор файла на серверах Telegram — повторная отправка без загрузки */
  fileId: string | null;
}

export class TelegramBotApi {
  private readonly api: Api;

  constructor(
    token: string,
    /**
     * Адрес Bot API. Не константа: у локального сервера Bot API свой хост, а
     * методы и пути те же (docs/20-env-and-ports.md §3.1).
     */
    apiRoot: string,
    /**
     * Сеть — нативный `fetch` (undici), а не `node-fetch`, который grammY
     * берёт на Node по умолчанию: один HTTP-клиент на бэкенд
     * (docs/16-tech-stack-decisions.md §5), и тесты подменяют его так же.
     */
    fetchImpl: FetchLike = fetch,
  ) {
    this.api = new Api(token, {
      apiRoot,
      fetch: fetchImpl as typeof fetch,
      // Срок задаёт каждый вызов своим сигналом: у долгого опроса и загрузки
      // документа он другой, а свой таймер grammY оборвал бы их раньше.
      timeoutSeconds: UPLOAD_TIMEOUT_MS / 1000,
    });
  }

  /** Кто этот бот: имя нужно для ссылки на Mini App (`t.me/<бот>?startapp`). */
  async getMe(signal?: AbortSignal): Promise<{ id: number; username: string | null }> {
    const result = await this.call("getMe", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getMe(abort));
    const me = z.object({ id: z.number().int(), username: z.string().optional() }).parse(result);
    return { id: me.id, username: me.username ?? null };
  }

  /**
   * Long polling. Нераспознанное обновление пропускается, а не роняет цикл:
   * Telegram добавляет поля, и схема обязана быть к этому терпима.
   */
  async getUpdates(offset: number | null, timeoutSec: number, signal?: AbortSignal): Promise<{ updates: TelegramUpdate[]; lastUpdateId: number | null }> {
    const result = await this.call("getUpdates", timeoutSec * 1000 + POLL_GRACE_MS, signal, (abort) =>
      this.api.getUpdates({ ...(offset === null ? {} : { offset }), timeout: timeoutSec, allowed_updates: [...ALLOWED_UPDATES] }, abort),
    );
    const raw = z.array(z.unknown()).parse(result);
    const updates: TelegramUpdate[] = [];
    let lastUpdateId: number | null = null;
    for (const item of raw) {
      const id = z.object({ update_id: z.number().int() }).safeParse(item);
      if (id.success) lastUpdateId = Math.max(lastUpdateId ?? id.data.update_id, id.data.update_id);
      const parsed = updateSchema.safeParse(item);
      if (parsed.success) updates.push(parsed.data);
    }
    return { updates, lastUpdateId };
  }

  async sendMessage(chat: ChatRef, text: string, signal?: AbortSignal, options: SendOptions = {}): Promise<number> {
    const { chat_id, ...thread } = chatFields(chat);
    const result = await this.call("sendMessage", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.sendMessage(chat_id, text, { ...thread, ...replyMarkup(options) }, abort),
    );
    return sentMessageSchema.parse(result).message_id;
  }

  async editMessageText(chat: ChatRef, messageId: number, text: string, signal?: AbortSignal): Promise<void> {
    await this.call("editMessageText", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.editMessageText(chatTargetOf(chat).chatId, messageId, text, undefined, abort),
    );
  }

  /**
   * Картинка байтами или уже загруженным `file_id`. Отправка по `file_id` не
   * гоняет файл второй раз — так кэш карточек отдаёт их мгновенно.
   */
  async sendPhoto(chat: ChatRef, photo: Buffer | string, caption: string, signal?: AbortSignal, options: SendOptions = {}): Promise<SentPhoto> {
    const { chat_id, ...thread } = chatFields(chat);
    const file = typeof photo === "string" ? photo : new InputFile(photo, "card.png");
    const sent = await this.call("sendPhoto", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.sendPhoto(chat_id, file, { ...thread, caption, ...replyMarkup(options) }, abort),
    );
    const result = sentMessageSchema.parse(sent);
    // Telegram отдаёт несколько размеров; самый крупный — последний.
    return { messageId: result.message_id, fileId: result.photo?.at(-1)?.file_id ?? null };
  }

  /** Документ с диска потоком: архив выгрузки не читается в память целиком. */
  async sendDocument(chat: ChatRef, path: string, fileName: string, caption: string, signal?: AbortSignal): Promise<void> {
    const { chat_id, ...thread } = chatFields(chat);
    await this.call("sendDocument", UPLOAD_TIMEOUT_MS, signal, (abort) =>
      this.api.sendDocument(chat_id, new InputFile(path, fileName), { ...thread, caption }, abort),
    );
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void> {
    await this.call("answerCallbackQuery", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.answerCallbackQuery(callbackQueryId, text === undefined ? {} : { text }, abort),
    );
  }

  /**
   * Команды меню. Без чата — для всех; с чатом — только в нём: меню
   * администратора не показывается остальным (docs/28-diagnostics.md §6.1.2).
   */
  async setMyCommands(commands: BotCommand[], chat: ChatRef | null, signal?: AbortSignal, languageCode?: CommandsLanguage): Promise<void> {
    await this.call("setMyCommands", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setMyCommands(
        commands,
        {
          scope: chat === null ? { type: "default" } : { type: "chat", chat_id: chatTargetOf(chat).chatId },
          ...(languageCode === undefined ? {} : { language_code: languageCode }),
        },
        abort,
      ),
    );
  }

  /**
   * Ссылка на счёт для `openInvoice` в Mini App. Валюта — `XTR`, токен
   * провайдера для Stars пустой: платёж идёт через Telegram, а не эквайринг.
   */
  async createInvoiceLink(invoice: StarsInvoice, signal?: AbortSignal): Promise<string> {
    const result = await this.call("createInvoiceLink", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.createInvoiceLink(invoice.title, invoice.description, invoice.payload, "", "XTR", [{ label: invoice.label, amount: invoice.stars }], undefined, abort),
    );
    return z.url().parse(result);
  }

  async setWebhook(url: string, secretToken: string, signal?: AbortSignal): Promise<void> {
    await this.call("setWebhook", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setWebhook(url, { secret_token: secretToken, allowed_updates: [...ALLOWED_UPDATES], drop_pending_updates: false }, abort),
    );
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await this.call("deleteWebhook", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.deleteWebhook({ drop_pending_updates: false }, abort));
  }

  /**
   * Вызов с таймаутом и нашей ошибкой. Модули ветвятся по `TelegramApiError`
   * — коду и `retry_after`, — а не по классам grammY: так они не зависят от
   * библиотеки, и замена транспорта их не трогает.
   */
  private async call<T>(method: string, timeoutMs: number, signal: AbortSignal | undefined, run: (abort: GrammySignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const abort = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    try {
      // Расхождение только в типах полифила (см. GrammySignal): во время
      // работы это тот же нативный сигнал, который понимает наш `fetch`.
      return await run(abort as unknown as GrammySignal);
    } catch (error: unknown) {
      if (error instanceof GrammyError) {
        throw new TelegramApiError(method, error.error_code, error.description, error.parameters.retry_after ?? null);
      }
      // Сетевая ошибка может нести URL с токеном в `cause` — наружу уходит
      // только имя метода и тип исходной ошибки.
      const cause = error instanceof HttpError ? error.error : error;
      const reason = cause instanceof Error ? cause.name : "unknown";
      throw new TelegramApiError(method, 0, `сеть недоступна (${reason})`, null);
    }
  }
}

function replyMarkup(options: SendOptions): ReplyMarkup {
  return options.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.keyboard } };
}
