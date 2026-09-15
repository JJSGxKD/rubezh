import { z } from "zod";

/**
 * Четыре метода Bot API для сводки плейтеста — на `fetch`, без библиотеки
 * бота. Telegraf из docs/28-diagnostics.md §6.1 придёт вместе с модулем бота
 * на вебхуке; тянуть его ради одной команды незачем, а переносится команда
 * туда вызовом того же сервиса сводки.
 *
 * Токен живёт в URL запроса, поэтому URL не попадает ни в ошибки, ни в логи.
 */

const API_ROOT = "https://api.telegram.org";
/** Запас сверх long polling: Telegram держит запрос до `timeout` секунд и отвечает чуть позже. */
const POLL_GRACE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

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

const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      text: z.string().optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }).optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().int().optional() }).optional(),
});

export interface BotCommand {
  command: string;
  description: string;
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
      { offset: offset ?? undefined, timeout: timeoutSec, allowed_updates: ["message"] },
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

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text }, REQUEST_TIMEOUT_MS, signal);
  }

  async sendPhoto(chatId: string, png: Buffer, caption: string, signal?: AbortSignal): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", caption);
    form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "playtest-stats.png");
    await this.call("sendPhoto", form, REQUEST_TIMEOUT_MS, signal);
  }

  async setMyCommands(commands: BotCommand[], chatId: string, signal?: AbortSignal): Promise<void> {
    await this.call("setMyCommands", { commands, scope: { type: "chat", chat_id: chatId } }, REQUEST_TIMEOUT_MS, signal);
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
