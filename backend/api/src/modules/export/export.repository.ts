import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Чтение для выгрузки — страницами по индексу `received_at` и курсором по
 * ключу, а не OFFSET (docs/28-diagnostics.md §6.1.3): выгрузка «весь тест» не держит базу
 * одним долгим запросом и не зависит от памяти контейнера.
 */

export interface ExportPeriod {
  /** `null` — с начала теста */
  from: Date | null;
  to: Date;
}

export interface PageCursor {
  receivedAt: Date;
  id: string;
}

export interface EventExportRow {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  installId: string;
  platformUserId: string | null;
  sessionId: string;
  platform: string;
  appVersion: string;
  payload: unknown;
  occurredAt: Date;
  receivedAt: Date;
}

export interface ReportExportRow {
  reportId: string;
  kind: string;
  schemaVersion: string;
  appVersion: string;
  contentHash: string | null;
  installId: string;
  platformUserId: string | null;
  platform: string;
  device: unknown;
  summary: unknown;
  payload: unknown;
  sizeBytes: number;
  occurredAt: Date;
  receivedAt: Date;
}

export interface ExportJournalEntry {
  exportId: string;
  source: "bot" | "cli" | "panel";
  requestedBy: string;
  period: ExportPeriod;
}

export interface ExportJournalResult {
  status: "sent" | "failed";
  events: number;
  reports: number;
  sizeBytes: number;
  parts: number;
  error: string | null;
}

/** Строка журнала выгрузок — раздел выгрузок в панели. */
export interface ExportJournalRow {
  exportId: string;
  source: "bot" | "cli" | "panel";
  requestedBy: string;
  period: ExportPeriod;
  status: "running" | "sent" | "failed";
  events: number;
  reports: number;
  sizeBytes: number;
  parts: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export const EXPORT_REPOSITORY = Symbol("EXPORT_REPOSITORY");

export interface ExportRepository {
  /** последние выгрузки, свежие первыми */
  recent(limit: number): Promise<ExportJournalRow[]>;
  eventsPage(period: ExportPeriod, after: PageCursor | null, limit: number): Promise<EventExportRow[]>;
  reportsPage(period: ExportPeriod, after: PageCursor | null, limit: number): Promise<ReportExportRow[]>;
  /** конец периода последней удачной выгрузки этого человека — для «с последней выгрузки» */
  lastExportTo(requestedBy: string): Promise<Date | null>;
  start(entry: ExportJournalEntry): Promise<void>;
  finish(exportId: string, result: ExportJournalResult): Promise<void>;
}

@Injectable()
export class PrismaExportRepository implements ExportRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  eventsPage(period: ExportPeriod, after: PageCursor | null, limit: number): Promise<EventExportRow[]> {
    return this.prisma.analyticsEvent.findMany({
      where: {
        AND: [
          receivedIn(period),
          after === null ? {} : { OR: [{ receivedAt: { gt: after.receivedAt } }, { receivedAt: after.receivedAt, eventId: { gt: after.id } }] },
        ],
      },
      orderBy: [{ receivedAt: "asc" }, { eventId: "asc" }],
      take: limit,
    });
  }

  reportsPage(period: ExportPeriod, after: PageCursor | null, limit: number): Promise<ReportExportRow[]> {
    return this.prisma.diagnosticReport.findMany({
      where: {
        AND: [
          receivedIn(period),
          after === null ? {} : { OR: [{ receivedAt: { gt: after.receivedAt } }, { receivedAt: after.receivedAt, reportId: { gt: after.id } }] },
        ],
      },
      orderBy: [{ receivedAt: "asc" }, { reportId: "asc" }],
      take: limit,
    });
  }

  async recent(limit: number): Promise<ExportJournalRow[]> {
    const rows = await this.prisma.dataExport.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return rows.map((row) => ({
      exportId: row.exportId,
      source: row.source,
      requestedBy: row.requestedBy,
      period: { from: row.periodFrom, to: row.periodTo },
      status: row.status,
      events: row.events,
      reports: row.reports,
      sizeBytes: row.sizeBytes,
      parts: row.parts,
      error: row.error,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }));
  }

  async lastExportTo(requestedBy: string): Promise<Date | null> {
    const last = await this.prisma.dataExport.findFirst({
      where: { requestedBy, status: "sent" },
      orderBy: { createdAt: "desc" },
      select: { periodTo: true },
    });
    return last?.periodTo ?? null;
  }

  async start(entry: ExportJournalEntry): Promise<void> {
    await this.prisma.dataExport.create({
      data: {
        exportId: entry.exportId,
        source: entry.source,
        requestedBy: entry.requestedBy,
        periodFrom: entry.period.from,
        periodTo: entry.period.to,
        status: "running",
      },
    });
  }

  async finish(exportId: string, result: ExportJournalResult): Promise<void> {
    await this.prisma.dataExport.update({
      where: { exportId },
      data: { ...result, error: result.error?.slice(0, 512) ?? null, finishedAt: new Date() },
    });
  }
}

function receivedIn(period: ExportPeriod): { receivedAt: { gte?: Date; lt: Date } } {
  return { receivedAt: { ...(period.from === null ? {} : { gte: period.from }), lt: period.to } };
}
