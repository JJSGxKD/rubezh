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

@Injectable()
export class PrismaRequestJournalRepository implements RequestJournalRepository {
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
}
