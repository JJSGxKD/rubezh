import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError } from "../../common/domain-error.js";
import { EXPORT_REPOSITORY, type ExportJournalRow, type ExportRepository } from "../export/export.repository.js";
import { ExportService, type ExportArtifact } from "../export/export.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import type { Period } from "./admin-parse.js";

/**
 * Выгрузки из панели (docs/29-admin-panel.md §2, «Выгрузки данных»): тот же
 * архив, что отдаёт бот, — одна реализация в `ExportService`, здесь только
 * журнал, право и аудит. Путь через бота остаётся быстрым.
 */
@Injectable()
export class AdminExportsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EXPORT_REPOSITORY) private readonly journal: ExportRepository,
    private readonly exports: ExportService,
    private readonly roles: RolesService,
  ) {}

  async recent(limit: number): Promise<ExportJournalRow[]> {
    return await this.journal.recent(limit);
  }

  /** Собрать архив за период. Выгрузка — чувствительное чтение: в журнал аудита до отдачи файла. */
  async build(actor: AccountRef, period: Period): Promise<ExportArtifact> {
    await this.roles.require(actor, "data.export");
    if (this.config.export.pseudonymKey === "") throw new DisabledError("Выгрузка выключена: не задан ключ псевдонимов");

    const artifact = await this.exports.build({ period, source: "panel", requestedBy: actor.platformUserId });
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "data.export",
      target: artifact.exportId,
      after: { from: period.from.toISOString(), to: period.to.toISOString(), ...artifact.counts, sizeBytes: artifact.sizeBytes },
    });
    return artifact;
  }

  /** Чем кончилась отдача файла — в журнал выгрузок; временные файлы убираются в любом исходе. */
  async settle(artifact: ExportArtifact, status: "sent" | "failed", error: string | null): Promise<void> {
    await artifact.cleanup();
    await this.exports.finish(artifact.exportId, {
      status,
      events: artifact.counts.events,
      reports: artifact.counts.reports,
      sizeBytes: artifact.sizeBytes,
      parts: 1,
      error,
    });
  }
}
