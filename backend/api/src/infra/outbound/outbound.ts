import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { OutboundService } from "./outbound-services.js";
import { safePath } from "./outbound-path.js";

/** Запись об одной попытке исходящего запроса — без секретов из адреса. */
export interface OutboundRecord {
  service: string;
  method: string;
  host: string;
  /** путь без query и без секретов: токен бота и ключи заменены звёздочками */
  path: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  /** `direct` или id прокси */
  via: string;
  attempt: number;
  /** `timeout`, `network`, `aborted` или `null` */
  error: string | null;
  at: Date;
}

export interface OutboundSink {
  write(record: OutboundRecord): void;
}

/** Приёмник по умолчанию: ничего не пишет. Журнал подключает отдельная задача. */
export const NOOP_SINK: OutboundSink = { write: () => undefined };

export const OUTBOUND_SINK = Symbol("OUTBOUND_SINK");
/** Часы клиента; не задан — настоящее время. Нужны тестам. */
export const OUTBOUND_CLOCK = Symbol("OUTBOUND_CLOCK");

/** Как часто сбой приёмника попадает в лог: запись идёт на каждый запрос, лог не должен расти вместе с ней. */
const SINK_WARN_EVERY_MS = 60_000;

/**
 * Единый клиент исходящих запросов (docs/35-stage4-plan.md Р91, Р92, WP47):
 * `forService` отдаёт функцию с сигнатурой `fetch`, поэтому место вызова
 * меняет только то, откуда берёт `fetch`. Каждая попытка — запись в приёмник.
 *
 * Своего таймаута у клиента нет: срок задаёт сигнал вызывающего, он есть у
 * каждого места вызова. Ответ отдаётся как есть, исключение пробрасывается.
 * Запись не задерживает и не роняет вызов.
 */
@Injectable()
export class Outbound {
  private readonly logger = new Logger("outbound");
  private lastSinkWarnAt = 0;
  private readonly now: () => Date;

  constructor(
    @Inject(OUTBOUND_SINK) private readonly sink: OutboundSink,
    @Optional() @Inject(OUTBOUND_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** `fetch` с меткой сервиса: вызов, время и исход уходят в приёмник. */
  forService(service: OutboundService): typeof fetch {
    return async (input, init) => {
      const at = this.now();
      const started = performance.now();
      const { host, path } = safePath(urlOf(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const record = (status: number | null, ok: boolean, error: string | null): void =>
        this.write({ service, method, host, path, status, ok, durationMs: Math.max(0, performance.now() - started), via: "direct", attempt: 1, error, at });

      try {
        const response = await fetch(input, init);
        record(response.status, response.ok, null);
        return response;
      } catch (error: unknown) {
        record(null, false, errorKind(error));
        throw error;
      }
    };
  }

  private write(record: OutboundRecord): void {
    try {
      this.sink.write(record);
    } catch (error: unknown) {
      const at = Date.now();
      if (at - this.lastSinkWarnAt < SINK_WARN_EVERY_MS) return;
      this.lastSinkWarnAt = at;
      this.logger.warn(JSON.stringify({ module: "outbound", event: "sink_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Исход без текста исключения: в нём бывает адрес со всеми секретами. */
function errorKind(error: unknown): string {
  if (error instanceof Error || (typeof error === "object" && error !== null && "name" in error)) {
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError") return "timeout";
    if (name === "AbortError") {
      const cause = (error as { cause?: unknown }).cause;
      return cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "aborted";
    }
  }
  return "network";
}
