import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { FxModule } from "../fx/fx.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { BotModule } from "../../platforms/telegram/bot.module.js";
import { DAILY_STATS_REPOSITORY, PrismaDailyStatsRepository } from "./daily-stats.repository.js";
import { DAILY_STATS_LOCKS, DailyStatsReporter, RedisDailyStatsLocks } from "./daily-stats.reporter.js";
import { FxAlertNotifier } from "./fx-alert-notifier.js";
import { ReportNotifier } from "./report-notifier.js";
import { RedisReviewThrottle, REVIEW_THROTTLE } from "./review-throttle.js";

/**
 * Уведомления в чат администраторов: карточки отчётов диагностики —
 * выключаются переключателем `notify.reports` — и забегов на разбор
 * антифрода — выключаются пустым адресом разбора вместе с общим — и алерты
 * курсов валют в общий чат, пока включён их опрос, и ежедневная статистика
 * в чат статистики (`daily-stats.reporter.ts`). Адреса и переключатель —
 * настройки (`modules/settings`): панель сильнее окружения.
 */
@Module({
  imports: [DiagnosticsModule, RunsModule, AuthModule, FxModule, BotModule],
  providers: [
    ReportNotifier,
    FxAlertNotifier,
    { provide: REVIEW_THROTTLE, useClass: RedisReviewThrottle },
    DailyStatsReporter,
    { provide: DAILY_STATS_REPOSITORY, useClass: PrismaDailyStatsRepository },
    { provide: DAILY_STATS_LOCKS, useClass: RedisDailyStatsLocks },
  ],
  // Цифры суток читает и сводка панели — тем же запросом, что отчёт в чат.
  exports: [DAILY_STATS_REPOSITORY],
})
export class AdminNotifyModule {}
