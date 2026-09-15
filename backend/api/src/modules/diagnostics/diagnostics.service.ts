import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ForbiddenError, RateLimitedError, UnavailableError, ValidationError } from "../../common/domain-error.js";
import type { IngestIdentity } from "../ingest/ingest.guard.js";
import { INGEST_LIMITS } from "../ingest/ingest-limits.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { DiagnosticsHooks } from "./diagnostics-hooks.js";
import { DIAGNOSTICS_REPOSITORY, type DiagnosticsRepository } from "./diagnostics.repository.js";
import { benchSummaryOf } from "./diagnostics-summary.js";
import { submitBenchReportSchema } from "./dto/bench-report.dto.js";
import { reportEnvelopeSchema, type BenchSubmission } from "./dto/report-envelope.dto.js";

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
    const parsed = submitBenchReportSchema.safeParse(envelope.data.payload);
    if (!parsed.success || parsed.data.reportId !== envelope.data.reportId) {
      throw new ValidationError("Некорректный отчёт стресс-теста");
    }
    if (!stressTestOpen(this.config, identity.platformUserId)) {
      throw new ForbiddenError("Стресс-тест сейчас недоступен");
    }
    await this.enforceLimits(envelope.data.installId, identity.platformUserId);

    const payload = withoutPersonalData(parsed.data);
    const summary = benchSummaryOf(payload);
    let inserted: boolean;
    try {
      inserted = await this.repository.insert({
        reportId: envelope.data.reportId,
        kind: envelope.data.kind,
        schemaVersion: payload.report.schema,
        appVersion: envelope.data.appVersion,
        contentHash: envelope.data.contentHash,
        installId: envelope.data.installId,
        platformUserId: identity.platformUserId,
        platform: envelope.data.platform,
        device: envelope.data.device,
        summary,
        payload,
        sizeBytes: Buffer.byteLength(JSON.stringify(payload)),
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

    if (inserted) {
      void this.hooks.emit({
        reportId: envelope.data.reportId,
        kind: envelope.data.kind,
        appVersion: envelope.data.appVersion,
        installId: envelope.data.installId,
        platformUserId: identity.platformUserId,
        device: envelope.data.device,
        summary,
        payload,
        receivedAt: now,
      });
    }
    return { reportId: envelope.data.reportId, duplicate: !inserted };
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
