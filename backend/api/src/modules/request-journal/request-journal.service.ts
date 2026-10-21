import { Inject, Injectable, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { BUCKET_COUNT, JOURNAL_CLOCK, quantileMs } from "./journal-rules.js";
import {
  REQUEST_JOURNAL_READER,
  type InboundRouteRow,
  type InboundSeriesPoint,
  type OutboundCallRow,
  type RequestJournalReader,
} from "./request-journal.repository.js";

/**
 * Чтение журнала запросов для раздела «Запросы» (docs/35-stage4-plan.md Р92,
 * tasks/T-0061): периоды — окна от «сейчас» назад, перцентили входящих — из
 * корзин времени, ось графика — без дыр. Хранилище отдаёт строки, всё
 * остальное собирается здесь, чтобы контроллер остался разбором запроса.
 */

export const REQUEST_PERIODS = ["hour", "day", "week"] as const;
export type RequestPeriod = (typeof REQUEST_PERIODS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const SPAN_MS: Record<RequestPeriod, number> = { hour: HOUR_MS, day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS };
/** Шаг графика входящих: час — по минутам, сутки и неделя — по часам (иначе на неделе тридцать тысяч точек). */
const STEP: Record<RequestPeriod, "minute" | "hour"> = { hour: "minute", day: "hour", week: "hour" };
const STEP_MS = { minute: MINUTE_MS, hour: HOUR_MS } as const;

/** Вызовов на странице таблицы. */
export const CALLS_PAGE = 100;
const READ_TIMEOUT_MS = 15_000;
/** Допуск на ошибку умножения долей, тот же, что у `quantileMs`. */
const EPSILON = 1e-9;

/**
 * Время ответа. `atLeast` — значение попало в корзину «дольше»: у неё верхней
 * границы нет, и 5000 читается как «не меньше 5 с», а не «5 с».
 */
export interface Latency {
  ms: number;
  atLeast: boolean;
}

export interface OutboundServiceSummary {
  service: string;
  count: number;
  errors: number;
  /** доля ошибок от 0 до 1, до четырёх знаков */
  errorRate: number;
  viaProxy: number;
  median: Latency | null;
  p95: Latency | null;
}

export interface OutboundSummary {
  period: RequestPeriod;
  from: string;
  to: string;
  services: OutboundServiceSummary[];
}

export interface OutboundCall extends Omit<OutboundCallRow, "at"> {
  at: string;
}

export interface OutboundPage {
  calls: OutboundCall[];
  /** `id` для `before` следующей страницы; `null` — страниц больше нет */
  next: string | null;
}

export interface InboundRoute {
  method: string;
  route: string;
  count: number;
  c4xx: number;
  c5xx: number;
  median: Latency | null;
  p95: Latency | null;
}

export interface InboundPoint {
  at: string;
  total: number;
  errors: number;
}

export interface InboundReport {
  period: RequestPeriod;
  step: "minute" | "hour";
  from: string;
  to: string;
  series: InboundPoint[];
  routes: InboundRoute[];
}

export interface OutboundCallsFilter {
  service: string | null;
  onlyErrors: boolean;
  before: string | null;
}

/** Доля с четырьмя знаками: 5 из 200 — 0,025, без хвоста вида 0,02500000001. */
function rate(part: number, total: number): number {
  return total <= 0 ? 0 : Math.round((part / total) * 10_000) / 10_000;
}

function exact(ms: number | null): Latency | null {
  return ms === null ? null : { ms, atLeast: false };
}

/** Доля `q` ответов набралась в корзине «дольше»: ровно та проверка, на которой `quantileMs` отдаёт нижнюю границу. */
function overflowed(buckets: readonly number[], q: number): boolean {
  let total = 0;
  for (const count of buckets) if (Number.isFinite(count) && count > 0) total += count;
  if (total <= 0) return false;
  let below = 0;
  for (const count of buckets.slice(0, BUCKET_COUNT - 1)) if (Number.isFinite(count) && count > 0) below += count;
  return below + EPSILON < Math.max(total * q, Number.MIN_VALUE);
}

function latencyOf(buckets: readonly number[], q: number): Latency | null {
  const ms = quantileMs(buckets, q);
  return ms === null ? null : { ms, atLeast: overflowed(buckets, q) };
}

@Injectable()
export class RequestJournalService {
  private readonly now: () => number;

  constructor(
    @Inject(REQUEST_JOURNAL_READER) private readonly reader: RequestJournalReader,
    @Optional() @Inject(JOURNAL_CLOCK) now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  async outboundSummary(period: RequestPeriod): Promise<OutboundSummary> {
    const { from, to } = this.window(period);
    const rows = await withTimeout(this.reader.outboundSummary(from, to), READ_TIMEOUT_MS, "сводка исходящих");
    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      services: rows.map((row) => ({
        service: row.service,
        count: row.count,
        errors: row.errors,
        errorRate: rate(row.errors, row.count),
        viaProxy: row.viaProxy,
        median: exact(row.medianMs),
        p95: exact(row.p95Ms),
      })),
    };
  }

  async outboundCalls(period: RequestPeriod, filter: OutboundCallsFilter): Promise<OutboundPage> {
    const { from } = this.window(period);
    // Лишняя строка нужна только узнать, есть ли следующая страница.
    const rows = await withTimeout(
      this.reader.outboundCalls({ from, service: filter.service, onlyErrors: filter.onlyErrors, beforeId: filter.before, limit: CALLS_PAGE + 1 }),
      READ_TIMEOUT_MS,
      "вызовы исходящих",
    );
    const page = rows.slice(0, CALLS_PAGE);
    const last = page.at(-1);
    return {
      calls: page.map((row) => ({ ...row, at: row.at.toISOString() })),
      next: rows.length > CALLS_PAGE && last !== undefined ? last.id : null,
    };
  }

  async inbound(period: RequestPeriod): Promise<InboundReport> {
    const { from, to } = this.window(period);
    const step = STEP[period];
    const stepMs = STEP_MS[step];
    // Первый шаг оси берётся целиком: срез минуты или часа посередине нарисовал бы провал.
    const axisFrom = new Date(Math.floor(from.getTime() / stepMs) * stepMs);
    const [routes, series] = await Promise.all([
      withTimeout(this.reader.inboundRoutes(from, to), READ_TIMEOUT_MS, "маршруты входящих"),
      withTimeout(this.reader.inboundSeries(axisFrom, to, step), READ_TIMEOUT_MS, "график входящих"),
    ]);
    return {
      period,
      step,
      from: from.toISOString(),
      to: to.toISOString(),
      series: filledSeries(series, axisFrom, to, stepMs),
      routes: mergedRoutes(routes),
    };
  }

  private window(period: RequestPeriod): { from: Date; to: Date } {
    const now = this.now();
    return { from: new Date(now - SPAN_MS[period]), to: new Date(now) };
  }
}

/** Ось от первого шага до шага, в котором «сейчас», включительно; шаги без ответов — нули. */
function filledSeries(points: readonly InboundSeriesPoint[], from: Date, to: Date, stepMs: number): InboundPoint[] {
  const byTime = new Map(points.map((point) => [point.at.getTime(), point]));
  const result: InboundPoint[] = [];
  const last = Math.floor(to.getTime() / stepMs) * stepMs;
  for (let at = from.getTime(); at <= last; at += stepMs) {
    const point = byTime.get(at);
    result.push({ at: new Date(at).toISOString(), total: point?.total ?? 0, errors: point?.errors ?? 0 });
  }
  return result;
}

/** Строки «маршрут × класс статуса» — в маршруты: классы складываются, корзины тоже; первыми — самые нагруженные. */
function mergedRoutes(rows: readonly InboundRouteRow[]): InboundRoute[] {
  const routes = new Map<string, { method: string; route: string; count: number; c4xx: number; c5xx: number; buckets: number[] }>();
  for (const row of rows) {
    const key = `${row.method} ${row.route}`;
    const entry = routes.get(key) ?? { method: row.method, route: row.route, count: 0, c4xx: 0, c5xx: 0, buckets: [] };
    entry.count += row.count;
    if (row.statusClass === "4xx") entry.c4xx += row.count;
    if (row.statusClass === "5xx") entry.c5xx += row.count;
    for (const [index, value] of row.buckets.entries()) entry.buckets[index] = (entry.buckets[index] ?? 0) + value;
    routes.set(key, entry);
  }
  return [...routes.values()]
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route) || a.method.localeCompare(b.method))
    .map(({ buckets, ...route }) => ({ ...route, median: latencyOf(buckets, 0.5), p95: latencyOf(buckets, 0.95) }));
}
