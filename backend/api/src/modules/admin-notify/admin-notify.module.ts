import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { FxModule } from "../fx/fx.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { FxAlertNotifier } from "./fx-alert-notifier.js";
import { ReportNotifier } from "./report-notifier.js";
import { RedisReviewThrottle, REVIEW_THROTTLE } from "./review-throttle.js";

/**
 * Уведомления в чат администраторов (`ADMIN_CHAT_ID`): карточки отчётов
 * диагностики — выключаются `ADMIN_NOTIFY_REPORTS=false` — и забегов на
 * разбор антифрода — выключаются пустым адресом (`ADMIN_CHAT_RUN_REVIEW`
 * вместе с общим) — и алерты курсов валют в общий чат, пока включён их опрос.
 */
@Module({
  imports: [DiagnosticsModule, RunsModule, AuthModule, FxModule],
  providers: [ReportNotifier, FxAlertNotifier, { provide: REVIEW_THROTTLE, useClass: RedisReviewThrottle }],
})
export class AdminNotifyModule {}
