import type { OutboundRecord } from "../../infra/outbound/outbound.js";

/**
 * Числа и чистые правила журнала запросов (docs/35-stage4-plan.md Р92,
 * tasks/T-0060). Ни ввода-вывода, ни Nest: всё, что можно проверить без Redis
 * и базы, живёт здесь.
 */

/** Верхние границы корзин времени ответа, мс; ответ дольше последней границы — в корзине «дольше». */
export const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
/** Корзин вместе с «дольше»: столько чисел в массиве `buckets` строки сводки. */
export const BUCKET_COUNT = LATENCY_BUCKETS_MS.length + 1;

/** Сколько суток хранятся обе таблицы. */
export const JOURNAL_KEEP_DAYS = 7;
/** Потолок буфера исходящих: лишнее отбрасывается — журнал наблюдает, а не учитывает. */
export const OUTBOUND_BUFFER_MAX = 2000;
/** Как часто буфер уходит в базу. */
export const OUTBOUND_FLUSH_MS = 5_000;
/** Сколько сбросов подряд база может не принять пачку, прежде чем пачку выбросят. */
export const FLUSH_ATTEMPTS = 3;
/** Как часто один и тот же сбой попадает в лог: запись идёт на каждый запрос, лог не должен расти вместе с ней. */
export const WARN_EVERY_MS = 60_000;

/** Срок жизни ключа минуты в Redis: переносу есть из чего повторять два часа. */
export const INBOUND_KEY_TTL_SEC = 7200;
/** После сбоя Redis входящие не считаются столько мс: запросы игроков не копят зависшие команды. */
export const INBOUND_PAUSE_MS = 10_000;
/** Как часто сводку переносят в базу. */
export const ROLLUP_TICK_MS = 60_000;
/**
 * Запас после конца минуты: команда счётчика, начатая в последнюю секунду
 * минуты, может дойти до Redis уже после начала следующей (таймаут команды —
 * две секунды). Пока запаса нет, минуту не трогают.
 */
export const ROLLUP_GRACE_MS = 5_000;
/** Сколько строк за раз удаляет уборка. */
export const CLEANUP_BATCH = 5000;

/** Метка для ответов, которым не нашёлся маршрут (404 на произвольный адрес). Адрес в сводку не попадает. */
export const NO_ROUTE = "(нет маршрута)";

/** Длины колонок таблиц журнала. */
export const MAX_METHOD_LENGTH = 8;
export const MAX_ROUTE_LENGTH = 160;

/** Часы журнала в мс; не заданы — настоящее время. Нужны тестам. */
export const JOURNAL_CLOCK = Symbol("JOURNAL_CLOCK");

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

function isStatusClass(value: string): value is StatusClass {
  return value === "2xx" || value === "3xx" || value === "4xx" || value === "5xx";
}

/** Индекс корзины: граница входит в свою корзину, ответ дольше всех границ — последняя. */
export function bucketOf(durationMs: number): number {
  if (!(durationMs > 0)) return 0;
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
  return index === -1 ? LATENCY_BUCKETS_MS.length : index;
}

/** Класс статуса ответа. Промежуточных 1xx среди итоговых ответов сервера нет — они считаются как 2xx. */
export function statusClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/** Допуск на ошибку умножения: 0,07 · 100 в числах с плавающей точкой — это 7,000000000000001. */
const EPSILON = 1e-9;

/**
 * Верхняя граница корзины, в которой набралась доля `q` ответов. У корзины
 * «дольше» верхней границы нет, поэтому для неё возвращается нижняя — 5000:
 * значение читается как «не меньше». Пусто — `null`.
 */
export function quantileMs(buckets: readonly number[], q: number): number | null {
  let total = 0;
  for (const count of buckets) if (Number.isFinite(count) && count > 0) total += count;
  if (total <= 0) return null;
  const target = Math.max(total * Math.min(Math.max(q, 0), 1), Number.MIN_VALUE);
  let cumulative = 0;
  for (const [index, count] of buckets.entries()) {
    // Пустая корзина доли не набирает, даже когда нужная доля — почти ноль.
    if (!Number.isFinite(count) || count <= 0) continue;
    cumulative += count;
    if (cumulative + EPSILON >= target) return boundOf(index);
  }
  return boundOf(LATENCY_BUCKETS_MS.length);
}

function boundOf(index: number): number {
  return LATENCY_BUCKETS_MS[Math.min(index, LATENCY_BUCKETS_MS.length - 1)] ?? 0;
}

const MINUTE_KEY_PREFIX = "inbound:m:";

/** Ключ минуты в Redis: `inbound:m:YYYYMMDDHHmm` по UTC. */
export function minuteKey(at: Date): string {
  return MINUTE_KEY_PREFIX + at.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

/** Начало минуты, в которую попадает момент. */
export function minuteStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/** Проверки и пробы раз в десять секунд заглушили бы картину, поэтому в сводку они не входят. */
export function isServiceRoute(route: string): boolean {
  return route === "/health" || route.startsWith("/health/");
}

/** Что считает поле хеша минуты: число ответов или одну из корзин времени. */
export type InboundSlot = "n" | number;

export interface InboundField {
  method: string;
  statusClass: StatusClass;
  slot: InboundSlot;
  route: string;
}

/**
 * Имя поля хеша минуты. Маршрут стоит последним: разбор идёт по первым трём
 * разделителям, и знак «|» внутри маршрута ничего не ломает.
 */
export function inboundField(method: string, cls: StatusClass, slot: InboundSlot, route: string): string {
  return `${method}|${cls}|${String(slot)}|${route}`;
}

/** Обратное к `inboundField`; поле, которое не разбирается, — `null`: это след сбоя, а не данные. */
export function parseInboundField(field: string): InboundField | null {
  const first = field.indexOf("|");
  const second = field.indexOf("|", first + 1);
  const third = field.indexOf("|", second + 1);
  if (first <= 0 || second < 0 || third < 0) return null;
  const method = field.slice(0, first);
  const cls = field.slice(first + 1, second);
  const rawSlot = field.slice(second + 1, third);
  const route = field.slice(third + 1);
  if (method.length > MAX_METHOD_LENGTH || route === "" || route.length > MAX_ROUTE_LENGTH || !isStatusClass(cls)) return null;
  if (rawSlot === "n") return { method, statusClass: cls, slot: "n", route };
  const slot = Number(rawSlot);
  if (!/^\d+$/.test(rawSlot) || slot >= BUCKET_COUNT) return null;
  return { method, statusClass: cls, slot, route };
}

/** Строка `outbound_call` из записи клиента исходящих. */
export interface OutboundRow {
  at: Date;
  service: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  via: string;
  attempt: number;
  error: string | null;
}

const MAX_INT = 2_147_483_647;
const MAX_SMALLINT = 32_767;

function clip(value: string, max: number): string {
  // NUL Postgres в тексте не принимает, и одна такая строка уронила бы всю пачку.
  const clean = value.replaceAll("\u0000", "");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  // Разрезанная пара суррогатов — битый символ.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function clampInt(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : min;
}

/**
 * Запись приводится к колонкам здесь, а не отказом базы: пачка с одной
 * лишней буквой в пути не должна пропасть целиком.
 */
export function outboundRow(record: OutboundRecord): OutboundRow {
  return {
    at: record.at,
    service: clip(record.service, 32),
    method: clip(record.method, MAX_METHOD_LENGTH),
    host: clip(record.host, 128),
    path: clip(record.path, 256),
    status: record.status === null ? null : clampInt(record.status, 0, MAX_SMALLINT),
    ok: record.ok,
    durationMs: clampInt(record.durationMs, 0, MAX_INT),
    via: clip(record.via, 40),
    attempt: clampInt(record.attempt, 0, MAX_SMALLINT),
    error: record.error === null ? null : clip(record.error, 16),
  };
}
