import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { FxModule } from "../fx/fx.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { BotModule } from "../../platforms/telegram/bot.module.js";
import { ALL_TIME_REPOSITORY, PrismaAllTimeRepository } from "../admin/admin-all-time.repository.js";
import { ActivitySnapshotJob } from "./activity-snapshot.job.js";
import { DAILY_STATS_REPOSITORY, PrismaDailyStatsRepository } from "./daily-stats.repository.js";
import { DAILY_STATS_LOCKS, DailyStatsReporter, RedisDailyStatsLocks } from "./daily-stats.reporter.js";
import { FxAlertNotifier } from "./fx-alert-notifier.js";
import { PaymentsAlertNotifier } from "./payments-alert-notifier.js";
import { ReportNotifier } from "./report-notifier.js";
import { RedisReviewThrottle, REVIEW_THROTTLE } from "./review-throttle.js";
import { ServerErrorAlarm } from "./server-error-alarm.js";

/**
 * Уведомления в чат администраторов: карточки отчётов диагностики —
 * выключаются переключателем `notify.reports` — и забегов на разбор
 * антифрода — выключаются пустым адресом разбора вместе с общим — и алерты
 * курсов валют в общий чат, пока включён их опрос, сообщения о невыданных
 * покупках в поток «Покупки» (`payments-alert-notifier.ts`), тревога о
 * всплеске ответов 5xx в поток «Сбои сервера» (`server-error-alarm.ts`) и ежедневная
 * статистика в чат статистики (`daily-stats.reporter.ts`) и ночной снимок аудитории
 * для рекордов DAU/WAU/MAU (`activity-snapshot.job.ts`). Адреса и переключатель —
 * настройки (`modules/settings`): панель сильнее окружения.
 */
@Module({
  imports: [DiagnosticsModule, RunsModule, AuthModule, FxModule, PaymentsModule, BotModule],
  providers: [
    ReportNotifier,
    FxAlertNotifier,
    PaymentsAlertNotifier,
    ServerErrorAlarm,
    { provide: REVIEW_THROTTLE, useClass: RedisReviewThrottle },
    DailyStatsReporter,
    { provide: DAILY_STATS_REPOSITORY, useClass: PrismaDailyStatsRepository },
    { provide: DAILY_STATS_LOCKS, useClass: RedisDailyStatsLocks },
    // Суточные снимки аудитории (T-0203): репозиторий читают и задание, и панель «Чего достигли»
    { provide: ALL_TIME_REPOSITORY, useClass: PrismaAllTimeRepository },
    ActivitySnapshotJob,
  ],
  // Цифры суток читает и сводка панели — тем же запросом, что отчёт в чат;
  // счётчик ответов 5xx зовёт хук HTTP-приложения (`http-app.ts`); репозиторий итогов — сводке панели.
  exports: [DAILY_STATS_REPOSITORY, ALL_TIME_REPOSITORY, ServerErrorAlarm],
})
export class AdminNotifyModule {}
