import { Module } from "@nestjs/common";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { ReportNotifier } from "./report-notifier.js";

/**
 * Уведомления в чат администраторов (`ADMIN_CHAT_ID`) о новых отчётах
 * диагностики. Выключаются `ADMIN_NOTIFY_REPORTS=false`.
 */
@Module({
  imports: [DiagnosticsModule],
  providers: [ReportNotifier],
})
export class AdminNotifyModule {}
