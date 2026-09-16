import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { submitBenchReportSchema } from "./dto/bench-report.dto.js";
import { deviceSchema, type StoredDevice } from "./dto/device.dto.js";
import type { BenchSubmission, ReportKind } from "./dto/report-envelope.dto.js";
import { submitRunReportSchema, type RunSubmission } from "./dto/run-report.dto.js";

export interface ReportRecord {
  reportId: string;
  kind: ReportKind;
  schemaVersion: string;
  appVersion: string;
  contentHash: string | null;
  installId: string;
  platformUserId: string | null;
  platform: "telegram" | "max" | "vk" | "web";
  device: StoredDevice;
  summary: object;
  payload: unknown;
  sizeBytes: number;
  occurredAt: Date;
  receivedAt: Date;
}

export const DIAGNOSTICS_REPOSITORY = Symbol("DIAGNOSTICS_REPOSITORY");

/** Отчёт, прочитанный обратно: JSON из базы — граница системы, поэтому разобран схемами. */
export interface StoredBenchReport {
  reportId: string;
  appVersion: string;
  device: StoredDevice;
  payload: BenchSubmission;
}

export interface StoredRunReport {
  reportId: string;
  appVersion: string;
  device: StoredDevice;
  payload: RunSubmission;
}

export interface DiagnosticsRepository {
  /** `false` — отчёт с этим `reportId` уже есть: повтор ничего не записывает */
  insert(record: ReportRecord): Promise<boolean>;
  /** отчёт стресс-теста; `null` — нет такого или он не разбирается нынешней схемой */
  findBench(reportId: string): Promise<StoredBenchReport | null>;
  /** запись забега; `null` — нет такой или она не разбирается нынешней схемой */
  findRun(reportId: string): Promise<StoredRunReport | null>;
}

@Injectable()
export class PrismaDiagnosticsRepository implements DiagnosticsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insert(record: ReportRecord): Promise<boolean> {
    // createMany с пропуском повторов — это INSERT … ON CONFLICT DO NOTHING:
    // два одновременных повтора одного отчёта не падают на ключе, а один из
    // них честно получает «дубликат».
    const result = await this.prisma.diagnosticReport.createMany({
      data: [
        {
          ...record,
          device: record.device as Prisma.InputJsonObject,
          summary: record.summary as Prisma.InputJsonObject,
          payload: record.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async findBench(reportId: string): Promise<StoredBenchReport | null> {
    const row = await this.prisma.diagnosticReport.findUnique({
      where: { reportId },
      select: { reportId: true, kind: true, appVersion: true, device: true, payload: true },
    });
    if (row === null || row.kind !== "bench") return null;
    const device = deviceSchema.safeParse(row.device);
    const payload = submitBenchReportSchema.safeParse(row.payload);
    if (!device.success || !payload.success) return null;
    return { reportId: row.reportId, appVersion: row.appVersion, device: device.data, payload: payload.data };
  }

  async findRun(reportId: string): Promise<StoredRunReport | null> {
    const row = await this.prisma.diagnosticReport.findUnique({
      where: { reportId },
      select: { reportId: true, kind: true, appVersion: true, device: true, payload: true },
    });
    if (row === null || row.kind !== "run") return null;
    const device = deviceSchema.safeParse(row.device);
    const payload = submitRunReportSchema.safeParse(row.payload);
    if (!device.success || !payload.success) return null;
    return { reportId: row.reportId, appVersion: row.appVersion, device: device.data, payload: payload.data };
  }
}
