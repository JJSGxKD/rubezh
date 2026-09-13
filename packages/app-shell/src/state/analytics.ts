/**
 * Порт аналитики. Оболочка события порождает, отправляет их приложение —
 * движок и оболочка о сети не знают (docs/22-analytics-and-metrics.md §3.2,
 * docs/27-design-system-and-app-shell.md §3.1).
 *
 * Приёмник появится в WP8; до тех пор приложение подставляет вывод в консоль
 * или пустышку. Имя события берётся из словаря §3.3 — новое сначала
 * добавляется туда, потом в код.
 */
export type AnalyticsEvent =
  | "app_first_open"
  | "screen_viewed"
  | "settings_changed"
  | "run_started"
  | "run_resumed"
  | "run_finished"
  | "run_abandoned"
  | "run_paused"
  | "upgrade_offered"
  | "upgrade_chosen"
  | "wave_reached"
  | "load_time"
  | "diagnostics_mode_changed"
  | "client_error";

export type AnalyticsPayload = Record<string, string | number | boolean | null>;

export type AnalyticsSink = (event: AnalyticsEvent, payload: AnalyticsPayload) => void;

export const noopAnalytics: AnalyticsSink = () => undefined;
