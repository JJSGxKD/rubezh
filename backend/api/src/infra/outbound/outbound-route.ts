import type { OutboundService } from "./outbound-services.js";

/**
 * Маршрут исходящего запроса (docs/35-stage4-plan.md Р91, tasks/T-0065):
 * чистые функции без сети и без Nest — порядок попыток, что считается
 * неудачей, какое тело можно отправить повторно. Сами попытки, часы и память
 * о сработавшем прокси — в `outbound.ts`.
 *
 * Настраивается так (docs/30-configuration-map.md): список прокси и режим
 * каждого сервиса — в панели, раздел «Прокси»; умолчания режимов и пределы
 * времени — здесь.
 */

/**
 * Режим сервиса:
 * - `direct_first` — сначала напрямую, не вышло — прокси по порядку;
 * - `proxy_only` — только через прокси: прямой путь заведомо закрыт, ждать его
 *   таймаут незачем;
 * - `direct_only` — только напрямую: то, что прокси видеть не должен.
 */
export const OUTBOUND_MODES = ["direct_first", "proxy_only", "direct_only"] as const;
export type OutboundMode = (typeof OUTBOUND_MODES)[number];

/** Метка прямой попытки в плане и в журнале (`via`); у прокси метка — его id. */
export const DIRECT = "direct";

/** Предел попытки, за которой есть ещё попытки: напрямую и через прокси. У последней своего предела нет. */
export const DIRECT_ATTEMPT_MS = 3_000;
export const PROXY_ATTEMPT_MS = 5_000;

/** Сколько секунд прокси, через который сервис прошёл, пробуется первым среди прокси. */
export const ROUTE_MEMORY_SEC = 600;

/**
 * Умолчание режима. Bot API — только напрямую: токен бота стоит в адресе, и
 * чужой сервер его видеть не должен, пока команда не решит иначе.
 */
const DEFAULT_MODES: Partial<Record<OutboundService, OutboundMode>> = { "telegram.bot": "direct_only" };

export function defaultModeOf(service: OutboundService): OutboundMode {
  return DEFAULT_MODES[service] ?? "direct_first";
}

/** Прокси такой, как нужен клиенту: пароль уже расшифрован, он живёт только в памяти процесса. */
export interface OutboundProxy {
  id: string;
  scheme: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  /** чем меньше, тем раньше в переборе */
  priority: number;
  /** момент последней правки в мс: по нему меняется кэш диспетчера */
  updatedAt: number;
}

/**
 * Что клиенту нужно от модуля прокси. Чтение из памяти, без базы: модуль
 * держит снимок и обновляет его раз в 30 секунд и по сообщению в Redis.
 */
export interface OutboundRoutes {
  /** включённые прокси; порядок задаёт `priority`, но клиент сортирует сам */
  list(): readonly OutboundProxy[];
  modeOf(service: OutboundService): OutboundMode;
}

export const OUTBOUND_ROUTES = Symbol("OUTBOUND_ROUTES");

/** Какой прокси сработал последним для сервиса (`outbound:route:<сервис>` в Redis). */
export interface RouteMemory {
  get(service: string): Promise<string | null>;
  remember(service: string, proxyId: string): Promise<void>;
}

export const OUTBOUND_ROUTE_MEMORY = Symbol("OUTBOUND_ROUTE_MEMORY");

/** `fetch` через указанный прокси. Подменяется в тестах; в приложении — `undiciProxyFetch`. */
export type ProxyFetch = (proxy: OutboundProxy, input: Parameters<typeof fetch>[0], init: RequestInit | undefined) => Promise<Response>;

export const OUTBOUND_PROXY_FETCH = Symbol("OUTBOUND_PROXY_FETCH");

/** Режим `proxy_only` требует прокси, а включённых нет: прямой путь закрыт намеренно, обходить его нельзя. */
export class OutboundNoRouteError extends Error {
  constructor(service: string) {
    super(`Сервис ${service} работает только через прокси, а включённых прокси нет`);
    this.name = "OutboundNoRouteError";
  }
}

/**
 * Порядок попыток: `direct` и id прокси. Прокси идут по `priority`, при равных —
 * как в списке; запомненный прокси встаёт первым среди прокси, но не раньше
 * прямой попытки. Запомненный, которого нет в списке (выключен, удалён), ничего
 * не меняет.
 */
export function attemptPlan(mode: OutboundMode, proxies: readonly { id: string; priority: number }[], remembered: string | null): string[] {
  if (mode === "direct_only") return [DIRECT];
  const ordered = [...proxies].sort((a, b) => a.priority - b.priority).map((proxy) => proxy.id);
  const preferred = remembered !== null && ordered.includes(remembered) ? [remembered, ...ordered.filter((id) => id !== remembered)] : ordered;
  return mode === "proxy_only" ? preferred : [DIRECT, ...preferred];
}

/**
 * Переходить ли к следующей попытке после этого исхода: сетевой сбой, таймаут
 * попытки и отказ по стране (403, 451). Остальные ответы, и 5xx в их числе, —
 * ответ сервиса: прокси его не исправит. Отмену вызывающим (`aborted`) за
 * неудачу не считаем: он уже ушёл.
 */
export function shouldFallBack(outcome: { status: number | null; error: string | null }): boolean {
  if (outcome.error !== null) return outcome.error === "network" || outcome.error === "timeout";
  return outcome.status === 403 || outcome.status === 451;
}

function isRepeatableBody(body: NonNullable<RequestInit["body"]>): boolean {
  return typeof body === "string" || body instanceof URLSearchParams || body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/**
 * Можно ли отправить запрос повторно. Строку и байты — можно; поток читается
 * один раз, и запрос с ним идёт одной попыткой. Запрос-объект с телом — тоже
 * поток, пока вызывающий не передал тело отдельно.
 */
export function isReplayable(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (body !== undefined && body !== null) return isRepeatableBody(body);
  return !(input instanceof Request && input.body !== null);
}
