import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Строка события в том виде, в каком она едет через очередь: время — ISO-строкой,
 * потому что задания BullMQ хранятся в JSON.
 */
export interface EventRow {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  installId: string;
  platformUserId: string | null;
  sessionId: string;
  platform: "telegram" | "max" | "vk" | "web";
  appVersion: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
}

export const EVENTS_REPOSITORY = Symbol("EVENTS_REPOSITORY");

export interface EventsRepository {
  /** сколько строк действительно добавлено: повтор пачки добавляет ноль */
  insertMany(rows: readonly EventRow[]): Promise<number>;
}

@Injectable()
export class PrismaEventsRepository implements EventsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insertMany(rows: readonly EventRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    // Одна вставка на пачку (docs/14-scalability.md §4.1); повтор той же пачки
    // из ретрая очереди упирается в первичный ключ event_id и молча пропускается.
    const result = await this.prisma.analyticsEvent.createMany({
      data: rows.map((row) => ({
        ...row,
        payload: row.payload as Prisma.InputJsonObject,
        occurredAt: new Date(row.occurredAt),
        receivedAt: new Date(row.receivedAt),
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}
