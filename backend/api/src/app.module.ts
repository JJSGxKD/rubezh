import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";
import { PlaytestModule } from "./modules/playtest/playtest.module";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md).
 *
 * playtest — сохранения и лидерборд закрытого теста в Redis, тоже временные
 * и тоже выключены по умолчанию (docs/26-stage2-plan.md, WP13).
 */
@Module({
  imports: [AppConfigModule, PlaytestModule],
  controllers: [HealthController],
})
export class AppModule {}
