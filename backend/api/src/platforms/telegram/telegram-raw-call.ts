import { z } from "zod";
import { callSignal, networkError, TelegramApiError } from "./telegram-api-call.js";

/**
 * Сырой вызов Bot API для методов, которых нет в grammY: виджетов в 1.46.0
 * нет, перейти на методы grammY, когда они появятся. Ответ — граница системы
 * и разбирается схемой; ошибки отдаются тем же `TelegramApiError`, что и у
 * вызовов через grammY, поэтому модули различать транспорт не обязаны.
 */

export type RawFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface RawTransport {
  token: string;
  apiRoot: string;
  fetch: RawFetch;
}

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().int(),
    description: z.string(),
    parameters: z.object({ retry_after: z.number().int().optional() }).optional(),
  }),
]);

export async function rawBotCall<T>(
  transport: RawTransport,
  method: string,
  body: Record<string, unknown>,
  result: z.ZodType<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let text: string;
  try {
    // Токен живёт в адресе: сетевая ошибка может нести его в `cause`, поэтому
    // наружу уходит только тип ошибки (`networkError`).
    const response = await transport.fetch(`${transport.apiRoot}/bot${transport.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: callSignal(timeoutMs, signal),
    });
    text = await response.text();
  } catch (error: unknown) {
    throw networkError(method, error);
  }

  const envelope = envelopeSchema.safeParse(parseJson(text));
  if (!envelope.success) throw new TelegramApiError(method, 0, "ответ не по схеме", null);
  if (!envelope.data.ok) {
    const { error_code, description, parameters } = envelope.data;
    throw new TelegramApiError(method, error_code, description, parameters?.retry_after ?? null);
  }
  const parsed = result.safeParse(envelope.data.result);
  if (!parsed.success) throw new TelegramApiError(method, 0, "ответ не по схеме", null);
  return parsed.data;
}

/** `undefined` вместо исключения: ответ не JSON (страница прокси, обрыв) — это ответ не по схеме. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
