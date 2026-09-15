import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ForbiddenError, RateLimitedError, UnavailableError, ValidationError } from "../../common/domain-error.js";
import type { IngestIdentity } from "../ingest/ingest.guard.js";
import { INGEST_LIMITS } from "../ingest/ingest-limits.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { DIAGNOSTICS_REPOSITORY, type DiagnosticsRepository } from "./diagnostics.repository.js";
import { DiagnosticsHooks, type ReceivedReport } from "./diagnostics-hooks.js";
import { benchSummaryOf, runSummaryOf } from "./diagnostics-summary.js";
import { submitBenchReportSchema } from "./dto/bench-report.dto.js";
import { reportEnvelopeSchema, type BenchSubmission, type ReportEnvelope } from "./dto/report-envelope.dto.js";
import { submitRunReportSchema } from "./dto/run-report.dto.js";

export interface ReceiveResult {
  reportId: string;
  /** отчёт с этим `reportId` уже был — повтор ничего не записал */
  duplicate: boolean;
}

/**
 * Кому открыт стресс-тест (docs/28-diagnostics.md §2.3): всем, пока идёт
 * плейтест; администраторам — всегда; на машине разработчика — всем. Скрытая
 * кнопка в клиенте — не защита, поэтому правило проверяет и приёмник.
 */
export function stressTestOpen(config: AppConfig, platformUserId: string | null): boolean {
  if (config.playtest.enabled || config.nodeEnv === "development") return true;
  return platformUserId !== null && config.adminTelegramIds.has(platformUserId);
}

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger("diagnostics");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DIAGNOSTICS_REPOSITORY) private readonly repository: DiagnosticsRepository,
    private readonly limiter: RateLimiter,
    private readonly hooks: DiagnosticsHooks,
  ) {}

  async receive(body: unknown, identity: IngestIdentity, now: Date): Promise<ReceiveResult> {
    const envelope = reportEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw new ValidationError("Некорректный отчёт диагностики");
    const report = this.parse(envelope.data, identity, now);
    await this.enforceLimits(envelope.data.installId, identity.platformUserId);

    let inserted: boolean;
    try {
      inserted = await this.repository.insert({
        reportId: envelope.data.reportId,
        kind: report.kind,
        schemaVersion: report.kind === "bench" ? report.payload.report.schema : report.payload.recording.schema,
        appVersion: envelope.data.appVersion,
        contentHash: envelope.data.contentHash,
        installId: envelope.data.installId,
        platformUserId: identity.platformUserId,
        platform: envelope.data.platform,
        device: envelope.data.device,
        summary: report.summary,
        payload: report.payload,
        sizeBytes: Buffer.byteLength(JSON.stringify(report.payload)),
        occurredAt: new Date(envelope.data.occurredAt),
        receivedAt: now,
      });
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({ module: "diagnostics", event: "insert_failed", reason: error instanceof Error ? error.message : "unknown" }),
      );
      // Отчёт остаётся на устройстве и уйдёт повтором: reportId отсечёт дубль.
      throw new UnavailableError("Приём отчётов временно недоступен");
    }

    if (inserted) void this.hooks.emit(report);
    return { reportId: envelope.data.reportId, duplicate: !inserted };
  }

  /** `payload` по схеме своего вида; ключ идемпотентности внутри обязан совпасть с конвертом. */
  private parse(envelope: ReportEnvelope, identity: IngestIdentity, now: Date): ReceivedReport {
    const base = {
      reportId: envelope.reportId,
      appVersion: envelope.appVersion,
      installId: envelope.installId,
      platformUserId: identity.platformUserId,
      device: envelope.device,
      receivedAt: now,
    };

    if (envelope.kind === "run") {
      // Запись забега не закрыта правом, как стресс-тест: забег играет каждый,
      // а записывать его или нет, решает переключатель тестера.
      const parsed = submitRunReportSchema.safeParse(envelope.payload);
      if (!parsed.success || parsed.data.recording.reportId !== envelope.reportId) {
        throw new ValidationError("Некорректная запись забега");
      }
      return { ...base, kind: "run", summary: runSummaryOf(parsed.data), payload: parsed.data };
    }

    const parsed = submitBenchReportSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.reportId !== envelope.reportId) {
      throw new ValidationError("Некорректный отчёт стресс-теста");
    }
    if (!stressTestOpen(this.config, identity.platformUserId)) {
      throw new ForbiddenError("Стресс-тест сейчас недоступен");
    }
    const payload = withoutPersonalData(parsed.data);
    return { ...base, kind: "bench", summary: benchSummaryOf(payload), payload };
  }

  private async enforceLimits(installId: string, platformUserId: string | null): Promise<void> {
    const limits = INGEST_LIMITS.reports;
    if (!(await this.limiter.consume(limits.install, installId))) {
      throw new RateLimitedError("Слишком много отчётов с устройства, попробуйте позже");
    }
    if (platformUserId !== null && !(await this.limiter.consume(limits.user, platformUserId))) {
      throw new RateLimitedError("Слишком много отчётов, попробуйте позже");
    }
  }
}

/**
 * Строка браузера и Telegram ID из тела отчёта не записываются: устройство уже
 * описано разбором в конверте, а Telegram ID берётся только из проверенной
 * подписи (docs/28-diagnostics.md §8).
 */
function withoutPersonalData(submission: BenchSubmission): BenchSubmission {
  return {
    ...submission,
    report: {
      ...submission.report,
      device: { ...submission.report.device, userAgent: "", telegramUserId: null },
    },
  };
}
