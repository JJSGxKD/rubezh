import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { RolesModule } from "./modules/roles/roles.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { DatabaseModule } from "./infra/database.js";
import { RedisModule } from "./infra/redis.js";
import { AdminNotifyModule } from "./modules/admin-notify/admin-notify.module.js";
import { BotModule } from "./platforms/telegram/bot.module.js";
import { DiagnosticsModule } from "./modules/diagnostics/diagnostics.module.js";
import { FeedbackModule } from "./modules/feedback/feedback.module.js";
import { EventsModule } from "./modules/events/events.module.js";
import { ExportModule } from "./modules/export/export.module.js";
import { IngestModule } from "./modules/ingest/ingest.module.js";
import { TelegramModule } from "./platforms/telegram/telegram.module.js";
import { WelcomeModule } from "./modules/welcome/welcome.module.js";
import { PaymentsModule } from "./modules/payments/payments.module.js";
import { AttributionModule } from "./modules/attribution/attribution.module.js";
import { HealthController } from "./health/health.controller.js";
import { PlaytestModule } from "./modules/playtest/playtest.module.js";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md).
 *
 * playtest — сводка закрытого теста, отчёты о запуске и доступ к
 * инструментам, выключен по умолчанию (docs/26-stage2-plan.md, WP14). Забеги
 * и рейтинг из него переехали в runs.
 *
 * auth — аккаунты и сессии игроков (docs/34-stage3-plan.md, WP1);
 * roles — права, роли и журнал аудита (там же, WP2);
 * runs — забеги под аккаунтом и рейтинг на них (там же, WP4);
 * payments — второй шанс за Telegram Stars (там же, WP5);
 * attribution — сессии, первое и последнее касание (там же, WP6).
 */
@Module({
  imports: [AppConfigModule, RedisModule, DatabaseModule, IngestModule, TelegramModule, RolesModule, AuthModule, AttributionModule, RunsModule, PaymentsModule, BotModule, EventsModule, DiagnosticsModule, FeedbackModule, AdminNotifyModule, ExportModule, WelcomeModule, PlaytestModule],
  controllers: [HealthController],
})
export class AppModule {}
