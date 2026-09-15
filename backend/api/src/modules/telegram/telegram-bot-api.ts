import { openAsBlob } from "node:fs";
import { z } from "zod";

/**
 * Методы Bot API, которые нужны боту закрытого теста, — на `fetch`, без
 * библиотеки бота (docs/16-tech-stack-decisions.md §5): обновления, сообщения
 * с кнопками, картинки, документы, команды меню и вебхук. Ответы Telegram —
 * граница системы и разбираются схемой.
 *
 * Токен живёт в URL запроса, поэтому URL не попадает ни в ошибки, ни в логи.
 */

const API_ROOT = "https://api.telegram.org";
/** Запас сверх long polling: Telegram держит запрос до `timeout` секунд и отвечает чуть позже. */
const POLL_GRACE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Документ до 50 МБ по мобильному каналу сервера — ждём дольше обычного запроса. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Какие обновления бот читает: команды и нажатия кнопок. Остальное Telegram не шлёт вовсе. */
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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
      from: userSchema.optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(128),
      from: userSchema,
      data: z.string().max(64).optional(),
      message: z.object({ message_id: z.number().int(), chat: chatSchema }).optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;
export type TelegramUser = z.infer<typeof userSchema>;

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().int().optional() }).optional(),
});

const sentMessageSchema = z.object({
  message_id: z.number().int(),
  photo: z.array(z.object({ file_id: z.string() })).optional(),
});

export interface BotCommand {
  command: string;
  description: string;
}

/** Встроенные кнопки под сообщением: запуск Mini App или нажатие с данными. */
export type InlineButton = { text: string; web_app: { url: string } } | { text: string; callback_data: string };

export interface SendOptions {
  keyboard?: InlineButton[][];
}

export interface SentPhoto {
  messageId: number;
  /** идентификатор файла на серверах Telegram — повторная отправка без загрузки */
  fileId: string | null;
}

export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * Long polling. Нераспознанное обновление пропускается, а не роняет цикл:
   * Telegram добавляет поля, и схема обязана быть к этому терпима.
   */
  async getUpdates(offset: number | null, timeoutSec: number, signal?: AbortSignal): Promise<{ updates: TelegramUpdate[]; lastUpdateId: number | null }> {
    const result = await this.call(
      "getUpdates",
      { offset: offset ?? undefined, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES },
      timeoutSec * 1000 + POLL_GRACE_MS,
      signal,
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

  async sendMessage(chatId: string, text: string, signal?: AbortSignal, options: SendOptions = {}): Promise<number> {
    const result = await this.call(
      "sendMessage",
      { chat_id: chatId, text, ...replyMarkup(options) },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return sentMessageSchema.parse(result).message_id;
  }

  async editMessageText(chatId: string, messageId: number, text: string, signal?: AbortSignal): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text }, REQUEST_TIMEOUT_MS, signal);
  }

  /**
   * Картинка байтами или уже загруженным `file_id`. Отправка по `file_id` не
   * гоняет файл второй раз — так кэш карточек отдаёт их мгновенно.
   */
  async sendPhoto(chatId: string, photo: Buffer | string, caption: string, signal?: AbortSignal, options: SendOptions = {}): Promise<SentPhoto> {
    const markup = replyMarkup(options);
    const body: object | FormData =
      typeof photo === "string"
        ? { chat_id: chatId, photo, caption, ...markup }
        : formOf({ chat_id: chatId, caption, ...stringified(markup) }, "photo", new Blob([new Uint8Array(photo)], { type: "image/png" }), "card.png");
    const result = sentMessageSchema.parse(await this.call("sendPhoto", body, REQUEST_TIMEOUT_MS, signal));
    // Telegram отдаёт несколько размеров; самый крупный — последний.
    return { messageId: result.message_id, fileId: result.photo?.at(-1)?.file_id ?? null };
  }

  /** Документ с диска потоком: архив выгрузки не читается в память целиком. */
  async sendDocument(chatId: string, path: string, fileName: string, caption: string, signal?: AbortSignal): Promise<void> {
    const blob = await openAsBlob(path, { type: "application/octet-stream" });
    await this.call("sendDocument", formOf({ chat_id: chatId, caption }, "document", blob, fileName), UPLOAD_TIMEOUT_MS, signal);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void> {
    await this.call(
      "answerCallbackQuery",
      { callback_query_id: callbackQueryId, ...(text === undefined ? {} : { text }) },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  /**
   * Команды меню. Без чата — для всех; с чатом — только в нём: меню
   * администратора не показывается остальным (docs/28-diagnostics.md §6.1.2).
   */
  async setMyCommands(commands: BotCommand[], chatId: string | null, signal?: AbortSignal, languageCode?: string): Promise<void> {
    await this.call(
      "setMyCommands",
      {
        commands,
        scope: chatId === null ? { type: "default" } : { type: "chat", chat_id: chatId },
        ...(languageCode === undefined ? {} : { language_code: languageCode }),
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  async setWebhook(url: string, secretToken: string, signal?: AbortSignal): Promise<void> {
    await this.call(
      "setWebhook",
      { url, secret_token: secretToken, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false }, REQUEST_TIMEOUT_MS, signal);
  }

  private async call(method: string, body: object | FormData, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = {
      method: "POST",
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      ...(body instanceof FormData
        ? { body }
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ROOT}/bot${this.token}/${method}`, init);
    } catch (error: unknown) {
      // Сетевая ошибка undici может нести URL с токеном в `cause` — наружу
      // уходит только имя метода и тип ошибки.
      const reason = error instanceof Error ? error.name : "unknown";
      throw new TelegramApiError(method, 0, `сеть недоступна (${reason})`, null);
    }

    const envelope = envelopeSchema.safeParse(await response.json().catch(() => null));
    if (!envelope.success) throw new TelegramApiError(method, response.status, "ответ не по схеме Bot API", null);
    if (!envelope.data.ok) {
      throw new TelegramApiError(
        method,
        envelope.data.error_code ?? response.status,
        envelope.data.description ?? "без описания",
        envelope.data.parameters?.retry_after ?? null,
      );
    }
    return envelope.data.result;
  }
}

function replyMarkup(options: SendOptions): { reply_markup?: { inline_keyboard: InlineButton[][] } } {
  return options.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.keyboard } };
}

/** Поля формы — строки: разметку кнопок Telegram ждёт в ней JSON-строкой. */
function stringified(fields: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}

function formOf(fields: Record<string, string>, fileField: string, file: Blob, fileName: string): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(fileField, file, fileName);
  return form;
}
