import type { RateLimit } from "./rate-limiter.js";

/**
 * Лимиты приёмников (docs/28-diagnostics.md §5.3). Бизнес-параметры, а не
 * секреты: меняются здесь, в карте конфигурации — docs/30-configuration-map.md.
 *
 * По IP лимит щедрый намеренно: мобильные операторы сажают сотни абонентов на
 * один адрес, и тестеры из одного города не должны мешать друг другу. Жёсткие
 * лимиты — на установку и на Telegram ID.
 */
export type IngestKind = "events" | "reports" | "feedback";

export interface IngestLimits {
  /** потолок тела запроса: самый большой настоящий запрос с двукратным запасом */
  bodyBytes: number;
  /** запросов с одного IP */
  ip: RateLimit;
  /** единиц с одной установки: событий или отчётов */
  install: RateLimit;
  /** единиц с одного Telegram ID — повтор чужих данных запуска упирается сюда */
  user: RateLimit;
}

export const INGEST_LIMITS: Record<IngestKind, IngestLimits> = {
  events: {
    // Пачка — до 100 событий; `fetch` с keepalive при сворачивании всё равно
    // не унесёт больше 64 КБ.
    bodyBytes: 256 * 1024,
    ip: { scope: "events:ip", limit: 600, windowSec: 60 },
    install: { scope: "events:install", limit: 600, windowSec: 60 },
    user: { scope: "events:user", limit: 600, windowSec: 60 },
  },
  feedback: {
    // Форма короткая: три ответа и текст до двух тысяч знаков.
    bodyBytes: 16 * 1024,
    ip: { scope: "feedback:ip", limit: 60, windowSec: 3600 },
    install: { scope: "feedback:install", limit: 5, windowSec: 3600 },
    user: { scope: "feedback:user", limit: 5, windowSec: 3600 },
  },
  reports: {
    // Отчёт стресс-теста — сотни корзин таймлайна, запись забега — до 150 КБ
    // (docs/28-diagnostics.md §3.5).
    bodyBytes: 1024 * 1024,
    ip: { scope: "reports:ip", limit: 120, windowSec: 3600 },
    install: { scope: "reports:install", limit: 30, windowSec: 3600 },
    user: { scope: "reports:user", limit: 30, windowSec: 3600 },
  },
};
