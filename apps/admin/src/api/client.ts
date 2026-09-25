import { z } from "zod";

/**
 * Клиент API панели (docs/35-stage4-plan.md, WP17).
 *
 * Запросы — всегда на свой домен: на dev-сервере их проксирует Vite, в проде
 * — Caddy поддомена панели. Поэтому адреса API в сборке нет вовсе, а cookie
 * сессии (`HttpOnly; SameSite=Strict; Path=/api/v1/admin`) уходит сама:
 * скрипт страницы токен не видит и не хранит.
 *
 * Ответ — граница системы и разбирается схемой, а не `as`: сервер мог
 * обновиться раньше панели, и лучше честное «ответ не разобрался», чем
 * таблица с `undefined`.
 */

export const ADMIN_API = "/api/v1/admin";

/**
 * Изменяющий запрос обязан нести этот заголовок (серверная часть — admin-cookie.ts).
 * Чужая страница не выставит его без предварительного запроса CORS, а его
 * сервер не пропустит: защита от подделки запроса поверх `SameSite`.
 */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "rubezh-admin";

/** Обычный запрос панели. Сборка архива выгрузки ждёт дольше — своим параметром. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Почему не удалось — ровно столько, сколько нужно решить, что показать:
 *
 * - `offline` — сеть или таймаут: API не запущен или не ответил;
 * - `unauthorized` — сессии нет или она истекла: нужен вход;
 * - `forbidden` — нет права или вход в панель закрыт;
 * - `disabled` — панель выключена на сервере (`ADMIN_PANEL_ENABLED`);
 * - `not_found` — нет такого игрока или отчёта;
 * - `rate_limited` — слишком часто;
 * - `rejected` — сервер отверг данные формы;
 * - `unavailable` — ошибка сервера или ответ не разобрался.
 */
export type ApiFailure = "offline" | "unauthorized" | "forbidden" | "disabled" | "not_found" | "rate_limited" | "rejected" | "unavailable";

export interface ApiError {
  kind: ApiFailure;
  /** HTTP-статус; `null` — ответа не было */
  status: number | null;
  /** стабильный код ошибки сервера, если он был */
  code: string | null;
  /** текст для человека: от сервера, а без него — наш */
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type QueryValue = string | number | undefined;

export interface RequestOptions<T> {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  schema: z.ZodType<T>;
  timeoutMs?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const FALLBACK_MESSAGES: Record<ApiFailure, string> = {
  offline: "Нет связи с API — запущен ли бэкенд?",
  unauthorized: "Сессия истекла — войдите снова",
  forbidden: "Нет права на это действие",
  disabled: "Панель выключена на сервере (ADMIN_PANEL_ENABLED)",
  not_found: "Не найдено",
  rate_limited: "Слишком часто — подождите минуту",
  rejected: "Сервер отклонил данные",
  unavailable: "Сервер ответил ошибкой — подробности в логе API",
};

const errorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export class AdminApi {
  private readonly unauthorizedListeners = new Set<() => void>();

  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  /**
   * Сессия кончилась посреди работы — об этом узнаёт стор сессии и
   * показывает вход, а раздел не должен разбирать 401 сам.
   */
  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListeners.add(listener);
    return () => this.unauthorizedListeners.delete(listener);
  }

  async request<T>(path: string, options: RequestOptions<T>): Promise<ApiResult<T>> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET") headers[CSRF_HEADER] = CSRF_VALUE;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(urlOf(path, options.query), {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      return failure("offline", null, null, timedOut ? "API не ответил вовремя" : undefined);
    }

    const payload = await readJson(response);
    if (response.ok) {
      const parsed = z.object({ data: options.schema }).safeParse(payload);
      if (parsed.success) return { ok: true, data: parsed.data.data };
      return failure("unavailable", response.status, null, "Ответ сервера не разобрался — панель и API разных версий?");
    }

    const envelope = errorEnvelope.safeParse(payload);
    const code = envelope.success ? envelope.data.error.code : null;
    const kind = kindOf(response.status, code);
    if (kind === "unauthorized") for (const listener of this.unauthorizedListeners) listener();
    return failure(kind, response.status, code, envelope.success ? envelope.data.error.message : undefined);
  }
}

export function urlOf(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return `${ADMIN_API}${path}${search === "" ? "" : `?${search}`}`;
}

export function kindOf(status: number, code: string | null): ApiFailure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return code === "endpoint_disabled" ? "disabled" : "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "rejected";
  return "unavailable";
}

function failure(kind: ApiFailure, status: number | null, code: string | null, message?: string): { ok: false; error: ApiError } {
  return { ok: false, error: { kind, status, code, message: message ?? FALLBACK_MESSAGES[kind] } };
}

/** Тело не JSON — например, страница ошибки прокси: разбирать нечего, это не исключение. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
