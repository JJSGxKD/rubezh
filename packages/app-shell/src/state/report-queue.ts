import type { KeyValueStorage } from "@bh/shared-types";
import { z } from "zod/mini";
import type { ReportFailure } from "./diagnostic-reports";
import { REPORT_QUEUE_KEY } from "./report-keys";

/**
 * Очередь отчётов диагностики на устройстве (docs/28-diagnostics.md §4).
 *
 * Запись забега весит десятки килобайт, а закрыть приложение тестер может в
 * любую секунду. Поэтому отчёт сначала ложится в хранилище устройства, потом
 * уходит; не ушёл — повтор при следующем запуске и при появлении сети с
 * растущей паузой. Сервер подтвердил (новый или дубликат) — отчёт удаляется.
 * Повтор безопасен: `reportId` — ключ идемпотентности на сервере.
 *
 * `fetch` с keepalive здесь не годится — он не унесёт больше 64 КБ, — поэтому
 * при сворачивании отчёт просто остаётся в очереди.
 */

const QUEUE_KEY = REPORT_QUEUE_KEY;
const SENT_KEY = "bh.reports.v1.sent";
const EVICTED_KEY = "bh.reports.v1.evicted";

/** Потолки очереди (§3.5): неделя без сети не должна съесть хранилище. */
export const REPORT_QUEUE_MAX_ITEMS = 10;
export const REPORT_QUEUE_MAX_BYTES = 1_000_000;
/** Сколько отправленных показывать в «Последних отчётах». */
export const SENT_HISTORY_SIZE = 10;
const BASE_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export type ReportKind = "run" | "bench";

export interface QueuedReport {
  reportId: string;
  kind: ReportKind;
  /** конверт отчёта JSON-строкой — ровно то, что уйдёт на сервер */
  body: string;
  bytes: number;
  queuedAt: number;
  /** сколько вытесненных отчётов этот конверт уже сообщил серверу */
  carriesEvicted: number;
}

export interface SentReport {
  reportId: string;
  kind: ReportKind;
  bytes: number;
  sentAt: number;
}

/** `retry` — повтор по таймеру после неудачи */
export type FlushTrigger = "enqueue" | "launch" | "online" | "retry";

export interface ReportQueueState {
  pending: Omit<QueuedReport, "body">[];
  sent: SentReport[];
}

export interface ReportQueueDeps {
  storage: KeyValueStorage | undefined;
  send(body: string): Promise<ReportFailure | null>;
  /** отчёт отвергнут сервером — повтор не поможет, но знать об этом надо */
  onDropped(report: QueuedReport, failure: ReportFailure): void;
  now?: () => number;
  /** отложить повтор; по умолчанию — `setTimeout` */
  schedule?: (delayMs: number, run: () => void) => void;
}

export interface ReportQueue {
  /**
   * Положить отчёт. `build` получает, сколько отчётов вытеснено с прошлого
   * конверта: этот счётчик уходит с отчётом, и потерю видно на сервере.
   */
  enqueue(meta: { reportId: string; kind: ReportKind }, build: (evictedReports: number) => string): void;
  flush(trigger: FlushTrigger): Promise<void>;
  /** Отчёт отправлен мимо очереди — стресс-тест шлёт сам и повторяет кнопкой. */
  rememberSent(report: SentReport): void;
  state(): ReportQueueState;
  subscribe(listener: () => void): () => void;
}

const queuedSchema = z.object({
  reportId: z.string(),
  kind: z.enum(["run", "bench"]),
  body: z.string(),
  bytes: z.number(),
  queuedAt: z.number(),
  carriesEvicted: z.number(),
});
const sentSchema = z.object({ reportId: z.string(), kind: z.enum(["run", "bench"]), bytes: z.number(), sentAt: z.number() });

export function createReportQueue(deps: ReportQueueDeps): ReportQueue {
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ??
    ((delayMs: number, run: () => void) => {
      setTimeout(run, delayMs);
    });
  let retryScheduled = false;
  const listeners = new Set<() => void>();
  let queue = readList(deps.storage, QUEUE_KEY, queuedSchema);
  let sent = readList(deps.storage, SENT_KEY, sentSchema);
  let evicted = readCount(deps.storage);
  let sending = false;
  /** сервер сказал «приёмника нет» — до следующего запуска не стучимся */
  let disabled = false;
  let failures = 0;
  let nextAttemptAt = 0;
  // Снимок меняется только вместе с очередью: экран подписывается на него
  // через `useSyncExternalStore`, и новый объект на каждое чтение зациклил бы
  // перерисовку.
  let snapshot = snapshotOf(queue, sent);

  const changed = (): void => {
    deps.storage?.set(QUEUE_KEY, JSON.stringify(queue));
    deps.storage?.set(SENT_KEY, JSON.stringify(sent));
    deps.storage?.set(EVICTED_KEY, String(evicted));
    snapshot = snapshotOf(queue, sent);
    for (const listener of listeners) listener();
  };

  const flush = async (trigger: FlushTrigger): Promise<void> => {
    if (trigger === "retry") retryScheduled = false;
    if (sending || disabled || queue.length === 0) return;
    // Новый отчёт и появление сети — повод попробовать сразу, повтор ждёт паузу.
    if (trigger === "retry" && now() < nextAttemptAt) return;
    sending = true;
    try {
      while (queue.length > 0) {
        const report = queue[0];
        const failure = await deps.send(report.body);
        if (failure === null) {
          queue = queue.filter((item) => item.reportId !== report.reportId);
          sent = [{ reportId: report.reportId, kind: report.kind, bytes: report.bytes, sentAt: now() }, ...sent].slice(0, SENT_HISTORY_SIZE);
          failures = 0;
          changed();
          continue;
        }
        if (failure === "rejected" || failure === "forbidden") {
          // Сервер не примет этот отчёт никогда: держать его — значит вечно
          // упираться в него и не отправлять следующие.
          queue = queue.filter((item) => item.reportId !== report.reportId);
          changed();
          deps.onDropped(report, failure);
          continue;
        }
        if (failure === "disabled") {
          disabled = true;
          return;
        }
        failures++;
        const delayMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
        nextAttemptAt = now() + delayMs;
        if (!retryScheduled) {
          retryScheduled = true;
          schedule(delayMs, () => void flush("retry"));
        }
        return;
      }
    } finally {
      sending = false;
    }
  };

  return {
    enqueue(meta, build): void {
      if (queue.some((item) => item.reportId === meta.reportId)) return;
      const body = build(evicted);
      const report: QueuedReport = { ...meta, body, bytes: body.length, queuedAt: now(), carriesEvicted: evicted };
      evicted = 0;
      queue = [...queue, report];
      // Вытесняется самый старый: свежий забег важнее недельной давности.
      // Его счётчик переходит к следующему конверту, чтобы потери не пропали.
      while (queue.length > REPORT_QUEUE_MAX_ITEMS || (queue.length > 1 && totalBytes(queue) > REPORT_QUEUE_MAX_BYTES)) {
        const [oldest, ...rest] = queue;
        evicted += 1 + oldest.carriesEvicted;
        queue = rest;
      }
      changed();
      void flush("enqueue");
    },

    flush,

    rememberSent(report): void {
      sent = [report, ...sent.filter((item) => item.reportId !== report.reportId)].slice(0, SENT_HISTORY_SIZE);
      changed();
    },

    state(): ReportQueueState {
      return snapshot;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function snapshotOf(queue: readonly QueuedReport[], sent: SentReport[]): ReportQueueState {
  return { pending: queue.map(({ body: _body, ...meta }) => meta), sent };
}

function totalBytes(queue: readonly QueuedReport[]): number {
  return queue.reduce((sum, item) => sum + item.bytes, 0);
}

/** Хранилище — граница системы: битая очередь сбрасывается, а не роняет запуск. */
function readList<T>(storage: KeyValueStorage | undefined, key: string, schema: z.ZodMiniType<T>): T[] {
  const raw = storage?.get(key) ?? null;
  if (raw === null) return [];
  try {
    const parsed = z.array(schema).safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch (error: unknown) {
    console.warn(`Очередь отчётов ${key} не читается:`, error);
  }
  storage?.remove(key);
  return [];
}

function readCount(storage: KeyValueStorage | undefined): number {
  const value = Number(storage?.get(EVICTED_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
