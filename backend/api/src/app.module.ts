import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./infra/database.js";
import { RedisModule } from "./infra/redis.js";
import { BotModule } from "./modules/bot/bot.module.js";
import { DiagnosticsModule } from "./modules/diagnostics/diagnostics.module.js";
import { EventsModule } from "./modules/events/events.module.js";
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
 */
@Module({
  imports: [AppConfigModule, RedisModule, DatabaseModule, IngestModule, TelegramModule, BotModule, EventsModule, DiagnosticsModule, WelcomeModule, PlaytestModule],
  controllers: [HealthController],
})
export class AppModule {}
