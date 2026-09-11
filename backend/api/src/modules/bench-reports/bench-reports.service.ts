import { Injectable, Logger } from "@nestjs/common";
import type { SubmitBenchReportDto } from "./dto/bench-report.dto";
import { BenchReportsRepository } from "./bench-reports.repository";
import type { BenchReportSummary, StoredBenchReport } from "./types/stored-bench-report";

export interface SubmitResult {
  reportId: string;
  /** true, если отчёт с этим ключом уже был принят раньше */
  duplicate: boolean;
}

/** Сколько отчётов отдаём в списке по умолчанию. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Приём и выдача отчётов FPS-испытаний (docs/25-week1-fps-trials.md).
 *
 * Сервис не знает об HTTP: он принимает разобранный DTO и бросает доменные
 * ошибки, которые фильтр переводит в коды ответа
 * (docs/15-engineering-standards.md §2.3).
 */
@Injectable()
export class BenchReportsService {
  private readonly logger = new Logger("bench-reports");

  constructor(private readonly repository: BenchReportsRepository) {}

  async submit(dto: SubmitBenchReportDto): Promise<SubmitResult> {
    const record: StoredBenchReport = {
      reportId: dto.reportId,
      receivedAt: new Date().toISOString(),
      report: dto.report,
      verdict: dto.verdict,
    };

    const created = await this.repository.create(record);

    // Лог структурный: по нему видно, с какого устройства пришёл отчёт и чем
    // закончился прогон, без чтения самого файла.
    this.logger.log(
      JSON.stringify({
        module: "bench-reports",
        event: created ? "report_stored" : "report_duplicate",
        reportId: dto.reportId,
        verdict: dto.verdict.level,
        stoppedBy: dto.report.stoppedBy ?? "duration",
        interruptions: dto.report.interruptions ?? 0,
        displayHz: dto.report.totals.displayHz ?? null,
        peakObjects: Math.round(dto.report.totals.peakObjects ?? dto.report.totals.peakLoad),
        sustainedLoad: Math.round(dto.verdict.sustainedLoad),
        avgFps: Number(dto.report.totals.avgFps.toFixed(1)),
        telegramPlatform: dto.report.device.telegramPlatform,
        telegramVersion: dto.report.device.telegramVersion,
        devicePixelRatio: dto.report.device.devicePixelRatio,
      }),
    );

    return { reportId: dto.reportId, duplicate: !created };
  }

  async list(limit = DEFAULT_LIMIT): Promise<BenchReportSummary[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const records = await this.repository.findAll(safeLimit);

    return records.map((record) => ({
      reportId: record.reportId,
      receivedAt: record.receivedAt,
      startedAt: record.report.startedAt,
      verdict: record.verdict.level,
      stoppedBy: record.report.stoppedBy ?? "duration",
      interruptions: record.report.interruptions ?? 0,
      sustainedLoad: Math.round(record.verdict.sustainedLoad),
      peakObjects: Math.round(record.report.totals.peakObjects ?? record.report.totals.peakLoad),
      displayHz: record.report.totals.displayHz ?? null,
      avgFps: Number(record.report.totals.avgFps.toFixed(1)),
      p95FrameMs: Number(record.report.totals.p95FrameMs.toFixed(1)),
      mode: record.report.profile.mode,
      buildVersion: record.report.profile.buildVersion,
      device: record.report.device.userAgent,
      telegramPlatform: record.report.device.telegramPlatform,
      telegramVersion: record.report.device.telegramVersion,
      devicePixelRatio: record.report.device.devicePixelRatio,
    }));
  }
}
