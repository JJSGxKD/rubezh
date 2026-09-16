import { Injectable, Logger } from "@nestjs/common";
import type { BenchSummary, RunSummary } from "./diagnostics-summary.js";
import type { StoredDevice } from "./dto/device.dto.js";
import type { BenchSubmission } from "./dto/report-envelope.dto.js";
import type { RunSubmission } from "./dto/run-report.dto.js";

/**
 * Новый отчёт принят — кому это интересно: сводке плейтеста, уведомлениям в
 * чат администраторов. Модуль диагностики о них не знает: слушатели
 * подписываются сами, и новый потребитель не требует правки приёмника.
 */
interface ReceivedReportBase {
  reportId: string;
  appVersion: string;
  installId: string;
  platformUserId: string | null;
  device: StoredDevice;
  receivedAt: Date;
}

export type ReceivedReport =
  | (ReceivedReportBase & { kind: "bench"; summary: BenchSummary; payload: BenchSubmission })
  | (ReceivedReportBase & { kind: "run"; summary: RunSummary; payload: RunSubmission });

export type ReportListener = (report: ReceivedReport) => Promise<void>;

@Injectable()
export class DiagnosticsHooks {
  private readonly logger = new Logger("diagnostics");
  private readonly listeners: { name: string; listener: ReportListener }[] = [];

  onReport(name: string, listener: ReportListener): void {
    this.listeners.push({ name, listener });
  }

  /**
   * Слушатели работают после ответа тестеру и друг другу не мешают: упавшая
   * сводка не должна отменять уведомление, а медленное уведомление — держать
   * запрос.
   */
  emit(report: ReceivedReport): Promise<void> {
    return Promise.all(
      this.listeners.map(async ({ name, listener }) => {
        try {
          await listener(report);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "diagnostics",
              event: "listener_failed",
              listener: name,
              reportId: report.reportId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }
}
