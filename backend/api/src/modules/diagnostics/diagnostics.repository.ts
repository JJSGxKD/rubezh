import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { StoredDevice } from "./dto/device.dto.js";
import type { ReportKind } from "./dto/report-envelope.dto.js";

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

export interface DiagnosticsRepository {
  /** `false` — отчёт с этим `reportId` уже есть: повтор ничего не записывает */
  insert(record: ReportRecord): Promise<boolean>;
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
}
