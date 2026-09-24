/**
 * Порт аналитики. Оболочка события порождает, отправляет их приложение —
 * движок и оболочка о сети не знают (docs/22-analytics-and-metrics.md §3.2,
 * docs/27-design-system-and-app-shell.md §3.1).
 *
 * Имя события берётся из словаря §3.3 — новое сначала добавляется туда и в
 * словарь сервера (`backend/api/src/modules/events/event-dictionary.ts`), потом
 * в код. Расхождение трёх списков ловит `scripts/test/event-dictionary.test.ts`.
 */
export const ANALYTICS_EVENTS = [
  "app_first_open",
  "user_registered",
  "user_authenticated",
  "screen_viewed",
  "settings_changed",
  "share_offered",
  "share_completed",
  "run_started",
  "run_resumed",
  "run_finished",
  "run_abandoned",
  "run_paused",
  "upgrade_offered",
  "upgrade_chosen",
  "wave_reached",
  "run_synced",
  "continue_used",
  "purchase_initiated",
  "purchase_completed",
  "purchase_failed",
  "load_time",
  "diagnostics_mode_changed",
  "bench_finished",
  "feedback_sent",
  "client_error",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export type AnalyticsPayload = Record<string, string | number | boolean | null>;

export type AnalyticsSink = (event: AnalyticsEvent, payload: AnalyticsPayload) => void;

export const noopAnalytics: AnalyticsSink = () => undefined;

/** Событие вместе с моментом, когда оно случилось, — отправка может быть позже. */
export type TimedSink = (event: AnalyticsEvent, payload: AnalyticsPayload, atMs: number) => void;

export interface DeferredSink {
  sink: AnalyticsSink;
  /** подключить настоящего получателя: накопленное уходит ему сразу, по порядку */
  attach(target: TimedSink): void;
}

/**
 * Буфер до загрузки эмиттера: эмиттер приходит отдельным чанком после
 * главной, а `load_time` и `app_first_open` случаются раньше. Потолок — чтобы
 * не пришедший чанк не копил события бесконечно.
 */
export function createDeferredSink(limit = 200): DeferredSink {
  let pending: { event: AnalyticsEvent; payload: AnalyticsPayload; atMs: number }[] = [];
  let target: TimedSink | null = null;
  return {
    sink(event, payload): void {
      const atMs = Date.now();
      if (target !== null) {
        target(event, payload, atMs);
        return;
      }
      if (pending.length < limit) pending.push({ event, payload, atMs });
    },
    attach(next): void {
      target = next;
      for (const item of pending) next(item.event, item.payload, item.atMs);
      pending = [];
    },
  };
}

/** Раздать событие нескольким получателям: консоль разработчика и сервер. */
export function fanOut(...sinks: AnalyticsSink[]): AnalyticsSink {
  return (event, payload) => {
    for (const sink of sinks) sink(event, payload);
  };
}
