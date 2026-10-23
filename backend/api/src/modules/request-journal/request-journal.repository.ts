import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { OutboundRecord } from "../../infra/outbound/outbound.js";
import { outboundRow, type StatusClass } from "./journal-rules.js";

/**
 * Хранилище журнала запросов (docs/35-stage4-plan.md Р92, tasks/T-0060):
 * единственное место модуля, где есть Prisma.
 */

/** Одна строка сводки входящих — `inbound_minute`. */
export interface InboundMinuteRow {
  /** начало минуты */
  minute: Date;
  method: string;
  /** шаблон маршрута, не адрес */
  route: string;
  statusClass: StatusClass;
  count: number;
  /** число ответов по корзинам времени, последняя — «дольше» */
  buckets: number[];
}

/** Класс статуса из базы: колонка — обычная строка, и чужое значение строкой не станет типом. */
function isStatusClass(value: string): value is StatusClass {
  return value === "2xx" || value === "3xx" || value === "4xx" || value === "5xx";
}

export interface RequestJournalRepository {
  /** Пачка попыток исходящих запросов одной вставкой. */
  insertOutboundCalls(records: readonly OutboundRecord[]): Promise<void>;
  /** Сводка минуты с прибавлением к уже записанному: повтор записи складывает, а не затирает. */
  addInboundMinutes(rows: readonly InboundMinuteRow[]): Promise<void>;
  /** Удаляет до `limit` строк старше границы; сколько удалено — столько и вернулось. */
  deleteOutboundBefore(cutoff: Date, limit: number): Promise<number>;
  deleteInboundBefore(cutoff: Date, limit: number): Promise<number>;
}

export const REQUEST_JOURNAL_REPOSITORY = Symbol("REQUEST_JOURNAL_REPOSITORY");

/** Сводка исходящих по сервису за окно: медиана и 95-й перцентиль точные, по `duration_ms`. */
export interface OutboundServiceRow {
  service: string;
  count: number;
  /** вызовы с `ok = false` */
  errors: number;
  /** вызовы не напрямую, а через прокси */
  viaProxy: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** Одна попытка исходящего запроса для таблицы панели. */
export interface OutboundCallRow {
  /** `BIGINT` строкой: в число он не помещается без потерь */
  id: string;
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

export interface OutboundCallsQuery {
  /** начало окна периода */
  from: Date;
  service: string | null;
  onlyErrors: boolean;
  /** вернуть строки с `id` меньше этого; `null` — с самых новых */
  beforeId: string | null;
  limit: number;
}

/** Входящие по маршруту и классу статуса за окно: корзины времени сложены по минутам. */
export interface InboundRouteRow {
  method: string;
  route: string;
  statusClass: StatusClass;
  count: number;
  buckets: number[];
}

/** Точка графика входящих: все ответы и 5xx за шаг. */
export interface InboundSeriesPoint {
  at: Date;
  total: number;
  errors: number;
}

/**
 * Чтения журнала для раздела «Запросы» панели (tasks/T-0061). Отдельным
 * интерфейсом от записи: запись и уборка живут в модуле журнала, чтение — в
 * админском, и один не тянет за собой подмену другого.
 */
export interface RequestJournalReader {
  outboundSummary(from: Date, to: Date): Promise<OutboundServiceRow[]>;
  /** По `id` убыванием: новые вызовы первыми. */
  outboundCalls(query: OutboundCallsQuery): Promise<OutboundCallRow[]>;
  inboundRoutes(from: Date, to: Date): Promise<InboundRouteRow[]>;
  inboundSeries(from: Date, to: Date, step: "minute" | "hour"): Promise<InboundSeriesPoint[]>;
}

export const REQUEST_JOURNAL_READER = Symbol("REQUEST_JOURNAL_READER");

@Injectable()
export class PrismaRequestJournalRepository implements RequestJournalRepository, RequestJournalReader {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insertOutboundCalls(records: readonly OutboundRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.prisma.outboundCall.createMany({ data: records.map(outboundRow) });
  }

  /**
   * Массив корзин Prisma не прибавляет, поэтому `INSERT … ON CONFLICT` сырым
   * запросом: поэлементная сумма старого и нового массива. Все строки минуты —
   * одной транзакцией, чтобы сбой посреди не оставил минуту записанной наполовину
   * (иначе повтор переноса задвоил бы уже записанные строки).
   */
  async addInboundMinutes(rows: readonly InboundMinuteRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.$transaction(
      rows.map(
        (row) => this.prisma.$executeRaw`
          INSERT INTO inbound_minute (minute, method, route, status_class, count, buckets)
          VALUES (${row.minute}::timestamptz, ${row.method}, ${row.route}, ${row.statusClass}, ${row.count}, ${row.buckets}::int[])
          ON CONFLICT (minute, method, route, status_class) DO UPDATE SET
            count = inbound_minute.count + EXCLUDED.count,
            buckets = (
              SELECT COALESCE(array_agg(COALESCE(old_value, 0) + COALESCE(new_value, 0) ORDER BY position), '{}')
              FROM unnest(inbound_minute.buckets, EXCLUDED.buckets) WITH ORDINALITY AS sums(old_value, new_value, position)
            )`,
      ),
    );
  }

  async deleteOutboundBefore(cutoff: Date, limit: number): Promise<number> {
    return await this.prisma.$executeRaw`
      DELETE FROM outbound_call
      WHERE id IN (SELECT id FROM outbound_call WHERE at < ${cutoff}::timestamptz ORDER BY at LIMIT ${limit})`;
  }

  async deleteInboundBefore(cutoff: Date, limit: number): Promise<number> {
    return await this.prisma.$executeRaw`
      DELETE FROM inbound_minute
      WHERE (minute, method, route, status_class) IN (
        SELECT minute, method, route, status_class FROM inbound_minute WHERE minute < ${cutoff}::timestamptz LIMIT ${limit}
      )`;
  }

  async outboundSummary(from: Date, to: Date): Promise<OutboundServiceRow[]> {
    const rows = await this.prisma.$queryRaw<
      { service: string; count: number; errors: number; via_proxy: number; median_ms: number | null; p95_ms: number | null }[]
    >`
      SELECT service,
             count(*)::int AS count,
             (count(*) FILTER (WHERE NOT ok))::int AS errors,
             (count(*) FILTER (WHERE via <> 'direct'))::int AS via_proxy,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
      FROM outbound_call
      WHERE at >= ${from}::timestamptz AND at < ${to}::timestamptz
      GROUP BY service
      ORDER BY count(*) DESC, service`;
    return rows.map((row) => ({
      service: row.service,
      count: row.count,
      errors: row.errors,
      viaProxy: row.via_proxy,
      medianMs: row.median_ms === null ? null : Math.round(row.median_ms),
      p95Ms: row.p95_ms === null ? null : Math.round(row.p95_ms),
    }));
  }

  async outboundCalls(query: OutboundCallsQuery): Promise<OutboundCallRow[]> {
    const rows = await this.prisma.outboundCall.findMany({
      where: {
        at: { gte: query.from },
        ...(query.service === null ? {} : { service: query.service }),
        ...(query.onlyErrors ? { ok: false } : {}),
        ...(query.beforeId === null ? {} : { id: { lt: BigInt(query.beforeId) } }),
      },
      orderBy: { id: "desc" },
      take: query.limit,
    });
    return rows.map((row) => ({ ...row, id: row.id.toString() }));
  }

  /**
   * Корзины складываются по позициям в базе: ответов миллионы, а строк на
   * маршрут и класс — десятки. `count` и корзины считаются отдельными
   * выборками и сходятся по ключу.
   */
  async inboundRoutes(from: Date, to: Date): Promise<InboundRouteRow[]> {
    const rows = await this.prisma.$queryRaw<{ method: string; route: string; status_class: string; count: number; buckets: number[] }[]>`
      WITH totals AS (
        SELECT method, route, status_class, SUM(count)::int AS count
        FROM inbound_minute
        WHERE minute >= ${from}::timestamptz AND minute < ${to}::timestamptz
        GROUP BY method, route, status_class
      ), slots AS (
        SELECT m.method, m.route, m.status_class, u.position, SUM(u.value)::int AS slot_count
        FROM inbound_minute m CROSS JOIN LATERAL unnest(m.buckets) WITH ORDINALITY AS u(value, position)
        WHERE m.minute >= ${from}::timestamptz AND m.minute < ${to}::timestamptz
        GROUP BY m.method, m.route, m.status_class, u.position
      )
      SELECT t.method, t.route, t.status_class, t.count,
             COALESCE(array_agg(s.slot_count ORDER BY s.position) FILTER (WHERE s.position IS NOT NULL), '{}') AS buckets
      FROM totals t
      LEFT JOIN slots s ON s.method = t.method AND s.route = t.route AND s.status_class = t.status_class
      GROUP BY t.method, t.route, t.status_class, t.count`;
    return rows.flatMap((row) => (isStatusClass(row.status_class) ? [{ method: row.method, route: row.route, statusClass: row.status_class, count: row.count, buckets: row.buckets }] : []));
  }

  async inboundSeries(from: Date, to: Date, step: "minute" | "hour"): Promise<InboundSeriesPoint[]> {
    const rows = await this.prisma.$queryRaw<{ at: Date; total: number; errors: number }[]>`
      SELECT date_trunc(${step}::text, minute AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at,
             SUM(count)::int AS total,
             COALESCE(SUM(count) FILTER (WHERE status_class = '5xx'), 0)::int AS errors
      FROM inbound_minute
      WHERE minute >= ${from}::timestamptz AND minute < ${to}::timestamptz
      GROUP BY 1
      ORDER BY 1`;
    return rows;
  }
}
