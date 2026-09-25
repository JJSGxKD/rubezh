import { Module } from "@nestjs/common";
import { BotModule } from "../../platforms/telegram/bot.module.js";
import { EXPORT_BOT_LOCKS, ExportBotCommand, RedisExportBotLocks } from "./export-bot.command.js";
import { EXPORT_REPOSITORY, PrismaExportRepository } from "./export.repository.js";
import { ExportService } from "./export.service.js";
import { RetentionJob } from "./retention.job.js";

/**
 * Данные закрытого теста наружу и их срок жизни (docs/28-diagnostics.md §5.4,
 * §6): выгрузка архивом и очистка старше `DIAGNOSTICS_RETENTION_DAYS`.
 * Доставку выгрузки ведёт бот, запасной путь — `pnpm closed-test:export`.
 */
@Module({
  imports: [BotModule],
  providers: [
    ExportService,
    RetentionJob,
    ExportBotCommand,
    { provide: EXPORT_REPOSITORY, useClass: PrismaExportRepository },
    { provide: EXPORT_BOT_LOCKS, useClass: RedisExportBotLocks },
  ],
  // Журнал выгрузок — разделу выгрузок в панели.
  exports: [ExportService, EXPORT_REPOSITORY],
})
export class ExportModule {}
