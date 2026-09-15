import type { KeyValueStorage } from "@bh/shared-types";
import { z } from "zod/mini";
import type { AnalyticsEvent, AnalyticsPayload } from "./analytics";

/**
 * Эмиттер событий на сервер (docs/22-analytics-and-metrics.md §3.2,
 * docs/26-stage2-plan.md, WP8): буфер, пачки по таймеру и по размеру,
 * отправка при сворачивании и очередь на устройстве, пока нет сети.
 *
 * Модуль грузится после главной отдельным чанком: до него события копит
 * крошечный буфер из `analytics.ts`, и первая загрузка не растёт.
 *
 * Потеря события — деградация, удвоение — нет: повтор пачки сервер отсекает по
 * `eventId`, поэтому неудачная отправка просто остаётся в очереди.
 */

export interface TelemetryConfig {
  /** адрес API без косой в конце; пусто — тот же домен, что у приложения */
  baseUrl: string;
}

export interface TelemetryDeps {
  storage: KeyValueStorage | undefined;
  installId(): string;
  sessionId: string;
  appVersion: string;
  platform: string;
  signedLaunchData(): string | null;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

export interface Telemetry {
  record(event: AnalyticsEvent, payload: AnalyticsPayload, atMs: number): void;
  /** `hidden` — приложение уходит в фон: отправка с keepalive, без ожидания */
  flush(reason: "timer" | "size" | "hidden" | "online" | "launch"): Promise<void>;
  stop(): void;
}

const QUEUE_KEY = "bh.telemetry.v1.queue";
/** Потолок очереди на устройстве: без сети неделю она не должна съесть хранилище. */
export const TELEMETRY_MAX_QUEUED = 500;
export const TELEMETRY_BATCH_SIZE = 100;
/** Столько событий — повод отправить, не дожидаясь таймера. */
const FLUSH_AT = 25;
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** `fetch` с keepalive не унесёт тело больше 64 КБ — берём с запасом. */
const KEEPALIVE_MAX_BYTES = 60_000;
const SCHEMA_VERSION = 1;

const PLATFORMS = ["telegram", "max", "vk", "web"] as const;

const envelopeSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  schemaVersion: z.number(),
  occurredAt: z.string(),
  installId: z.string(),
  sessionId: z.string(),
  platform: z.enum(PLATFORMS),
  appVersion: z.string(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

type Envelope = z.infer<typeof envelopeSchema>;

export function createTelemetry(config: TelemetryConfig, deps: TelemetryDeps): Telemetry {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/api/v1/events`;
  const fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const platform = (PLATFORMS as readonly string[]).includes(deps.platform) ? (deps.platform as Envelope["platform"]) : "web";

  let queue: Envelope[] = readQueue(deps.storage);
  let sending = false;
  /** сервер сказал «приёмника нет» — до следующего запуска не стучимся */
  let disabled = false;
  let backoffMs = 0;
  let nextAttemptAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const persist = (): void => {
    deps.storage?.set(QUEUE_KEY, JSON.stringify(queue));
  };

  const release = (sent: readonly Envelope[]): void => {
    const ids = new Set(sent.map((event) => event.eventId));
    queue = queue.filter((event) => !ids.has(event.eventId));
    persist();
  };

  const headers = (): Record<string, string> => {
    const launch = deps.signedLaunchData();
    return {
      "content-type": "application/json",
      ...(launch === null || launch === "" ? {} : { authorization: `tma ${launch}` }),
    };
  };

  async function send(batch: readonly Envelope[], keepalive: boolean): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let status: number;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ events: batch }),
        keepalive,
        signal: controller.signal,
      });
      status = response.status;
    } catch {
      // Нет сети или таймаут: пачка остаётся в очереди до следующей попытки.
      status = 0;
    } finally {
      clearTimeout(timeout);
    }

    if (status >= 200 && status < 300) {
      release(batch);
      backoffMs = 0;
      return;
    }
    if (status === 403 || status === 404) {
      // Приёмник выключен или сборка не с того домена: события копятся до
      // потолка и уйдут, когда приёмник включат, — повторять сейчас бессмысленно.
      disabled = true;
      return;
    }
    if (status === 400 || status === 413) {
      // Сервер отверг саму пачку — повтор её не спасёт, а застрявшая в голове
      // очереди она не пускала бы остальные.
      release(batch);
      return;
    }
    backoffMs = backoffMs === 0 ? FLUSH_INTERVAL_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    nextAttemptAt = now() + backoffMs;
  }

  const telemetry: Telemetry = {
    record(event, payload, atMs): void {
      queue.push({
        eventId: eventUuid(),
        eventType: event,
        schemaVersion: SCHEMA_VERSION,
        occurredAt: new Date(atMs).toISOString(),
        installId: deps.installId(),
        sessionId: deps.sessionId,
        platform,
        appVersion: deps.appVersion,
        payload,
      });
      if (queue.length > TELEMETRY_MAX_QUEUED) queue = queue.slice(queue.length - TELEMETRY_MAX_QUEUED);
      persist();
      if (queue.length >= FLUSH_AT) void telemetry.flush("size");
    },

    async flush(reason): Promise<void> {
      const keepalive = reason === "hidden";
      // При сворачивании отправляем, даже если идёт обычная отправка: её
      // запрос браузер может оборвать вместе со страницей. Повтор тех же
      // событий сервер отсечёт по eventId.
      if (disabled || queue.length === 0 || (sending && !keepalive)) return;
      // При сворачивании ждать паузы нельзя: следующей попытки может не быть.
      if (!keepalive && reason !== "online" && now() < nextAttemptAt) return;

      if (keepalive) {
        // Сворачивание не ждёт ответа: страница может уйти раньше.
        const batch = fitKeepalive(queue);
        if (batch.length > 0) void send(batch, true);
        return;
      }
      sending = true;
      try {
        await send(queue.slice(0, TELEMETRY_BATCH_SIZE), false);
      } finally {
        sending = false;
      }
    },

    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };

  timer = setInterval(() => void telemetry.flush("timer"), FLUSH_INTERVAL_MS);
  return telemetry;
}

/**
 * Ключ идемпотентности события: сервер ждёт именно uuid. Без `randomUUID` —
 * случайные байты по разметке версии 4. Живёт здесь, а не рядом с
 * `createId`: общий модуль с первой загрузкой стал бы лишним чанком.
 */
function eventUuid(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Первые события, которые влезают в тело keepalive-запроса. */
function fitKeepalive(queue: readonly Envelope[]): Envelope[] {
  const batch: Envelope[] = [];
  let bytes = 16;
  for (const event of queue.slice(0, TELEMETRY_BATCH_SIZE)) {
    const size = JSON.stringify(event).length + 1;
    if (bytes + size > KEEPALIVE_MAX_BYTES) break;
    bytes += size;
    batch.push(event);
  }
  return batch;
}

function readQueue(storage: KeyValueStorage | undefined): Envelope[] {
  const raw = storage?.get(QUEUE_KEY) ?? null;
  if (raw === null) return [];
  try {
    const parsed = z.array(envelopeSchema).safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.slice(-TELEMETRY_MAX_QUEUED);
  } catch (error: unknown) {
    console.warn("Очередь событий испорчена и сброшена:", error);
  }
  storage?.remove(QUEUE_KEY);
  return [];
}
