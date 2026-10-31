import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import {
  DIRECT,
  DIRECT_ATTEMPT_MS,
  OUTBOUND_PROXY_FETCH,
  OUTBOUND_ROUTES,
  OUTBOUND_ROUTE_MEMORY,
  OutboundNoRouteError,
  PROXY_ATTEMPT_MS,
  attemptPlan,
  defaultModeOf,
  isReplayable,
  shouldFallBack,
  type OutboundProxy,
  type OutboundRoutes,
  type ProxyFetch,
  type RouteMemory,
} from "./outbound-route.js";
import type { OutboundService } from "./outbound-services.js";
import { safePath } from "./outbound-path.js";
import { undiciProxyFetch } from "./proxy-dispatcher.js";

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

/** Как часто один и тот же сбой попадает в лог: запись идёт на каждый запрос, лог не должен расти вместе с ней. */
const WARN_EVERY_MS = 60_000;
/** Память о маршруте — подсказка: ждать ответа Redis дольше этого незачем. */
const MEMORY_TIMEOUT_MS = 300;

type Input = Parameters<typeof fetch>[0];

/** Попытка плана: прямая (`proxy: null`) или через прокси. */
interface Attempt {
  via: string;
  proxy: OutboundProxy | null;
}

/**
 * Единый клиент исходящих запросов (docs/35-stage4-plan.md Р91, Р92, WP47,
 * tasks/T-0065): `forService` отдаёт функцию с сигнатурой `fetch`, поэтому
 * место вызова меняет только то, откуда берёт `fetch`. Каждая попытка — запись
 * в приёмник.
 *
 * Маршрут задаёт режим сервиса и список прокси из панели (`OutboundRoutes`).
 * Без списка и режима «только через прокси» запрос — одна прямая попытка, как
 * было до прокси. Иначе попытки идут по `attemptPlan`; к следующей клиент
 * переходит только после неудачи (`shouldFallBack`) и только пока тело можно
 * отправить повторно. Прошедший через прокси запоминается на десять минут.
 *
 * Сигнал вызывающего — общий предел на все попытки; у попытки, за которой есть
 * ещё, свой предел (3 с напрямую, 5 с через прокси). У последней своего
 * предела нет: ей остаётся срок вызывающего. Ответ — первый, где переход не
 * нужен, или последний; исключение последней попытки пробрасывается. Запись и
 * память маршрута не задерживают и не роняют вызов.
 */
@Injectable()
export class Outbound {
  private readonly logger = new Logger("outbound");
  private readonly lastWarnAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(
    @Inject(OUTBOUND_SINK) private readonly sink: OutboundSink,
    @Optional() @Inject(OUTBOUND_CLOCK) now?: () => Date,
    @Optional() @Inject(OUTBOUND_ROUTES) private readonly routes?: OutboundRoutes,
    @Optional() @Inject(OUTBOUND_ROUTE_MEMORY) private readonly memory?: RouteMemory,
    @Optional() @Inject(OUTBOUND_PROXY_FETCH) private readonly proxyFetch: ProxyFetch = undiciProxyFetch,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** `fetch` с меткой сервиса: вызов, время и исход каждой попытки уходят в приёмник. */
  forService(service: OutboundService): typeof fetch {
    return async (input, init) => {
      const attempts = await this.plan(service, input, init);
      return await this.run(service, attempts, input, init);
    };
  }

  private async plan(service: OutboundService, input: Input, init: RequestInit | undefined): Promise<Attempt[]> {
    const mode = this.routes?.modeOf(service) ?? defaultModeOf(service);
    const proxies = mode === "direct_only" ? [] : (this.routes?.list() ?? []);
    if (proxies.length === 0 && mode !== "proxy_only") return [{ via: DIRECT, proxy: null }];

    // Выбирать запомненный есть из чего, только когда прокси больше одного.
    const remembered = proxies.length > 1 ? await this.recall(service) : null;
    const ids = attemptPlan(mode, proxies, remembered);
    if (ids.length === 0) {
      this.warn(`no_route:${service}`, "outbound_no_route", { service });
      throw new OutboundNoRouteError(service);
    }
    const byId = new Map(proxies.map((proxy) => [proxy.id, proxy]));
    const attempts = ids.map((id): Attempt => ({ via: id, proxy: byId.get(id) ?? null }));
    // Поток повторно не отправить: такой запрос идёт одной, первой попыткой.
    return isReplayable(input, init) ? attempts : attempts.slice(0, 1);
  }

  private async run(service: OutboundService, attempts: readonly Attempt[], input: Input, init: RequestInit | undefined): Promise<Response> {
    const { host, path } = safePath(urlOf(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let lastError: unknown = null;

    for (const [index, attempt] of attempts.entries()) {
      const last = index === attempts.length - 1;
      const timer = last ? null : attemptTimer(attempt.proxy === null ? DIRECT_ATTEMPT_MS : PROXY_ATTEMPT_MS);
      const at = this.now();
      const started = performance.now();
      const record = (status: number | null, ok: boolean, error: string | null): void =>
        this.write({ service, method, host, path, status, ok, durationMs: Math.max(0, performance.now() - started), via: attempt.via, attempt: index + 1, error, at });

      try {
        const response = await this.send(attempt, input, withSignal(init, timer === null ? undefined : combine(caller, timer.signal)));
        record(response.status, response.ok, null);
        if (!last && shouldFallBack({ status: response.status, error: null })) {
          // Тело отказа не нужно: отпускаем соединение, а не ждём сборщик.
          void response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (attempt.proxy !== null && !shouldFallBack({ status: response.status, error: null })) this.remember(service, attempt.proxy.id);
        return response;
      } catch (error: unknown) {
        const kind = errorKind(error);
        record(null, false, kind);
        lastError = error;
        // Вызывающий отменил или его срок вышел — это конец, а не повод идти в прокси.
        if (last || caller?.aborted === true || !shouldFallBack({ status: null, error: kind })) throw error;
      } finally {
        timer?.clear();
      }
    }
    throw lastError;
  }

  private async send(attempt: Attempt, input: Input, init: RequestInit | undefined): Promise<Response> {
    return attempt.proxy === null ? await fetch(input, init) : await this.proxyFetch(attempt.proxy, input, init);
  }

  private async recall(service: string): Promise<string | null> {
    if (this.memory === undefined) return null;
    try {
      return await withTimeout(this.memory.get(service), MEMORY_TIMEOUT_MS, "память маршрута");
    } catch (error: unknown) {
      this.warn("route_memory_read", "outbound_route_memory_failed", { reason: reasonOf(error) });
      return null;
    }
  }

  /** Запоминание не ждём: вызывающему нужен ответ, а не запись в Redis. */
  private remember(service: string, proxyId: string): void {
    if (this.memory === undefined) return;
    withTimeout(this.memory.remember(service, proxyId), MEMORY_TIMEOUT_MS, "память маршрута").catch((error: unknown) => {
      this.warn("route_memory_write", "outbound_route_memory_failed", { reason: reasonOf(error) });
    });
  }

  private write(record: OutboundRecord): void {
    try {
      this.sink.write(record);
    } catch (error: unknown) {
      this.warn("sink", "sink_failed", { reason: reasonOf(error) });
    }
  }

  /** Сбой в лог не чаще раза в минуту на вид: события идут на каждый запрос. */
  private warn(kind: string, event: string, fields: Record<string, unknown>): void {
    const at = Date.now();
    if (at - (this.lastWarnAt.get(kind) ?? 0) < WARN_EVERY_MS) return;
    this.lastWarnAt.set(kind, at);
    this.logger.warn(JSON.stringify({ module: "outbound", event, ...fields }));
  }
}

function urlOf(input: Input): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

/**
 * Предел попытки своим таймером, а не `AbortSignal.timeout`: таймер убирается,
 * когда попытка кончилась, и не висит до срока. Причина отмены — `TimeoutError`,
 * поэтому в журнал она попадает как `timeout`.
 */
function attemptTimer(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(new DOMException(`Попытка не уложилась в ${String(ms)} мс`, "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(handle) };
}

/** Сигнал попытки: срок вызывающего и предел самой попытки — что раньше. */
function combine(caller: AbortSignal | undefined, limit: AbortSignal): AbortSignal {
  return caller === undefined ? limit : AbortSignal.any([caller, limit]);
}

/** Опции вызова с сигналом попытки; нет своего сигнала — опции как пришли, сигнал вызывающего остаётся при них. */
function withSignal(init: RequestInit | undefined, signal: AbortSignal | undefined): RequestInit | undefined {
  return signal === undefined ? init : { ...init, signal };
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
