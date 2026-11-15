import { z } from "zod";
import { TelegramApiError } from "./telegram-api-call.js";
import type { InlineButton } from "./telegram-bot-api.js";
import { rawBotCall, type RawFetch } from "./telegram-raw-call.js";

/**
 * Виджеты Bot API 10.4: живые карточки с состоянием, которое бот обновляет, и
 * запросы из них (`widget_query`). Виджетов в grammY 1.46.0 нет, поэтому вызовы
 * сырые, а ответы разбираются своими схемами (`telegram-raw-call.ts`).
 *
 * Границы размеров проверяются до сети: Telegram отвечает на нарушение общим
 * `400`, и по нему не понять, какое поле виновато. Нарушение — `RangeError`:
 * это ошибка вызывающего кода, а не отказ площадки.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * На запрос карточки Telegram ждёт ответа 15 секунд всего, и часть окна уже
 * ушла на доставку обновления и очередь: свой срок втрое короче.
 */
const ANSWER_TIMEOUT_MS = 5_000;

const MAX_HTML_BYTES = 32_768;
const MAX_DATA_BYTES = 1024;
const MAX_CAPTION_CHARS = 1024;
const MIN_HEIGHT = 50;
const MAX_HEIGHT = 600;
const MIN_CACHE_SEC = 5;
const MAX_CACHE_SEC = 3600;

export interface WidgetSend {
  /** 1–32 768 байта: страница карточки */
  html: string;
  width?: number;
  /** 50–600 */
  height?: number;
  /** до 1024 байт: состояние, общее для всех, кто видит карточку */
  publicData?: string;
  /** до 1024 байт: состояние этого чата */
  chatData?: string;
  /** до 1024 знаков */
  caption?: string;
  /** карточка может спрашивать бота (`widget_query`) */
  allowQueries?: boolean;
  isShared?: boolean;
  silent?: boolean;
  protect?: boolean;
  threadId?: number;
  keyboard?: InlineButton[][];
}

export interface SharedWidgetSend {
  chatData?: string;
  caption?: string;
  silent?: boolean;
  threadId?: number;
  keyboard?: InlineButton[][];
}

const sentWidgetSchema = z.object({
  message_id: z.number().int(),
  widget: z.object({ id: z.string().optional() }).optional(),
});
const sentMessageSchema = z.object({ message_id: z.number().int() });

export class TelegramWidgetApi {
  constructor(
    private readonly token: string,
    private readonly apiRoot: string,
    private readonly fetchImpl: RawFetch,
  ) {}

  async sendWidget(chatId: string, widget: WidgetSend, signal?: AbortSignal): Promise<{ messageId: number; widgetId: string | null }> {
    requireBytes("html", widget.html, 1, MAX_HTML_BYTES);
    requireOptionalBytes("public_data", widget.publicData, MAX_DATA_BYTES);
    requireOptionalBytes("chat_data", widget.chatData, MAX_DATA_BYTES);
    requireCaption(widget.caption);
    if (widget.height !== undefined && (!Number.isInteger(widget.height) || widget.height < MIN_HEIGHT || widget.height > MAX_HEIGHT)) {
      throw new RangeError(`Виджет: height должна быть целой от ${String(MIN_HEIGHT)} до ${String(MAX_HEIGHT)}`);
    }
    const sent = await this.call(
      "sendWidget",
      REQUEST_TIMEOUT_MS,
      {
        chat_id: chatId,
        html: widget.html,
        width: widget.width,
        height: widget.height,
        public_data: widget.publicData,
        chat_data: widget.chatData,
        caption: widget.caption,
        allow_queries: widget.allowQueries,
        is_shared: widget.isShared,
        disable_notification: widget.silent,
        protect_content: widget.protect,
        message_thread_id: widget.threadId,
        ...markup(widget.keyboard),
      },
      sentWidgetSchema,
      signal,
    );
    return { messageId: sent.message_id, widgetId: sent.widget?.id ?? null };
  }

  async sendSharedWidget(chatId: string, widgetId: string, options: SharedWidgetSend = {}, signal?: AbortSignal): Promise<{ messageId: number }> {
    requireOptionalBytes("chat_data", options.chatData, MAX_DATA_BYTES);
    requireCaption(options.caption);
    const sent = await this.call(
      "sendSharedWidget",
      REQUEST_TIMEOUT_MS,
      {
        chat_id: chatId,
        widget_id: widgetId,
        chat_data: options.chatData,
        caption: options.caption,
        disable_notification: options.silent,
        message_thread_id: options.threadId,
        ...markup(options.keyboard),
      },
      sentMessageSchema,
      signal,
    );
    return { messageId: sent.message_id };
  }

  /**
   * Обновить состояние карточки. Telegram на неизменившееся состояние отвечает
   * `400 message is not modified` — для обновления по расписанию это штатный
   * исход, а не сбой.
   */
  async editMessageWidgetData(
    chatId: string,
    messageId: number,
    data: { publicData?: string; chatData?: string },
    signal?: AbortSignal,
  ): Promise<"edited" | "unchanged"> {
    requireOptionalBytes("public_data", data.publicData, MAX_DATA_BYTES);
    requireOptionalBytes("chat_data", data.chatData, MAX_DATA_BYTES);
    try {
      await this.call(
        "editMessageWidgetData",
        REQUEST_TIMEOUT_MS,
        { chat_id: chatId, message_id: messageId, public_data: data.publicData, chat_data: data.chatData },
        z.unknown(),
        signal,
      );
      return "edited";
    } catch (error: unknown) {
      if (error instanceof TelegramApiError && error.errorCode === 400 && /message is not modified/i.test(error.message)) return "unchanged";
      throw error;
    }
  }

  /** Общее состояние общего виджета; `cacheTimeSec` — как долго клиенты держат его без запроса. */
  async editSharedWidgetData(widgetId: string, publicData: string, cacheTimeSec?: number, signal?: AbortSignal): Promise<void> {
    requireOptionalBytes("public_data", publicData, MAX_DATA_BYTES);
    if (cacheTimeSec !== undefined && (!Number.isInteger(cacheTimeSec) || cacheTimeSec < MIN_CACHE_SEC || cacheTimeSec > MAX_CACHE_SEC)) {
      throw new RangeError(`Виджет: cache_time должен быть целым от ${String(MIN_CACHE_SEC)} до ${String(MAX_CACHE_SEC)} секунд`);
    }
    await this.call("editSharedWidgetData", REQUEST_TIMEOUT_MS, { widget_id: widgetId, public_data: publicData, cache_time: cacheTimeSec }, z.unknown(), signal);
  }

  async answerWidgetQuery(queryId: string, data?: string, signal?: AbortSignal): Promise<void> {
    requireOptionalBytes("data", data, MAX_DATA_BYTES);
    await this.call("answerWidgetQuery", ANSWER_TIMEOUT_MS, { widget_query_id: queryId, data }, z.unknown(), signal);
  }

  private call<T>(method: string, timeoutMs: number, body: Record<string, unknown>, result: z.ZodType<T>, signal: AbortSignal | undefined): Promise<T> {
    return rawBotCall({ token: this.token, apiRoot: this.apiRoot, fetch: this.fetchImpl }, method, withoutUndefined(body), result, timeoutMs, signal);
  }
}

/** `JSON.stringify` и так выбросит `undefined`, но тело сравнивают и логируют — пусть оно будет честным. */
function withoutUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function markup(keyboard: InlineButton[][] | undefined): { reply_markup?: { inline_keyboard: InlineButton[][] } } {
  return keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } };
}

function requireBytes(field: string, value: string, min: number, max: number): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < min || bytes > max) throw new RangeError(`Виджет: ${field} должно быть от ${String(min)} до ${String(max)} байт, сейчас ${String(bytes)}`);
}

function requireOptionalBytes(field: string, value: string | undefined, max: number): void {
  if (value !== undefined) requireBytes(field, value, 0, max);
}

function requireCaption(caption: string | undefined): void {
  if (caption !== undefined && caption.length > MAX_CAPTION_CHARS) {
    throw new RangeError(`Виджет: caption не длиннее ${String(MAX_CAPTION_CHARS)} знаков, сейчас ${String(caption.length)}`);
  }
}
