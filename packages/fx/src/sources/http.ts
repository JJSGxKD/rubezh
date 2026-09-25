import type { z } from "zod";
import { SourceRateLimitedError, SourceUnavailableError } from "../sources.js";

/**
 * Запрос к источнику курсов. Срок запроса — сигнал вызывающего
 * (`AbortSignal.timeout`): у источника (`vpnsibcom_api`) таймаут стоял у
 * каждого вызова отдельно, здесь он один на опрос.
 *
 * Ответ курсов — килобайты. Мегабайт — уже не ответ, а ошибка прокси или
 * чужая страница, и читать его в память целиком незачем.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_BODY_BYTES = 1_000_000;

export async function fetchBytes(fetchImpl: FetchLike, source: string, url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "*/*", ...headers }, signal });
  } catch (error: unknown) {
    throw new SourceUnavailableError(source, error instanceof Error ? error.message : "сеть");
  }
  if (response.status === 429) throw new SourceRateLimitedError(source, retryAfterMs(response.headers.get("retry-after")));
  if (!response.ok) throw new SourceUnavailableError(source, `ответ ${response.status}`);

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new SourceUnavailableError(source, `ответ ${declared} байт — больше предела`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) throw new SourceUnavailableError(source, `ответ ${body.byteLength} байт — больше предела`);
  return body;
}

/** JSON с границы — только через схему: источник мог сменить формат. */
export async function fetchJson<T>(fetchImpl: FetchLike, source: string, url: string, signal: AbortSignal, schema: z.ZodType<T>, headers: Record<string, string> = {}): Promise<T> {
  const text = new TextDecoder().decode(await fetchBytes(fetchImpl, source, url, signal, { accept: "application/json", ...headers }));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceUnavailableError(source, "ответ не JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new SourceUnavailableError(source, "ответ не того формата");
  return parsed.data;
}

/** `Retry-After` — секунды или дата (RFC 9110). Непонятное значение — как отсутствие. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
