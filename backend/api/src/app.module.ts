import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { RolesModule } from "./modules/roles/roles.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { DatabaseModule } from "./infra/database.js";
import { RedisModule } from "./infra/redis.js";
import { AdminNotifyModule } from "./modules/admin-notify/admin-notify.module.js";
import { BotModule } from "./modules/bot/bot.module.js";
import { DiagnosticsModule } from "./modules/diagnostics/diagnostics.module.js";
import { FeedbackModule } from "./modules/feedback/feedback.module.js";
import { EventsModule } from "./modules/events/events.module.js";
import { ExportModule } from "./modules/export/export.module.js";
import { IngestModule } from "./modules/ingest/ingest.module.js";
import { TelegramModule } from "./modules/telegram/telegram.module.js";
import { WelcomeModule } from "./modules/welcome/welcome.module.js";
import { HealthController } from "./health/health.controller.js";
import { PlaytestModule } from "./modules/playtest/playtest.module.js";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md).
 *
 * playtest — сохранения и лидерборд закрытого теста в Redis, тоже временные
 * и тоже выключены по умолчанию (docs/26-stage2-plan.md, WP13).
 *
 * auth — аккаунты и сессии игроков (docs/34-stage3-plan.md, WP1);
 * roles — права, роли и журнал аудита (там же, WP2);
 * runs — забеги под аккаунтом и рейтинг на них (там же, WP4).
 */
@Module({
  imports: [AppConfigModule, RedisModule, DatabaseModule, IngestModule, TelegramModule, RolesModule, AuthModule, RunsModule, BotModule, EventsModule, DiagnosticsModule, FeedbackModule, AdminNotifyModule, ExportModule, WelcomeModule, PlaytestModule],
  controllers: [HealthController],
})
export class AppModule {}
