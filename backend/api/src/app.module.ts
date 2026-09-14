import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";
import { BenchReportsModule } from "./modules/bench-reports/bench-reports.module";
import { PlaytestModule } from "./modules/playtest/playtest.module";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md).
 *
 * bench-reports — инструмент недели 1, а не часть продукта: приёмник отчётов
 * FPS-испытаний с реальных устройств (docs/25-week1-fps-trials.md). Выключен
 * по умолчанию и включается переменной на время прогонов.
 *
 * playtest — сохранения и лидерборд закрытого теста в Redis, тоже временные
 * и тоже выключены по умолчанию (docs/26-stage2-plan.md, WP13).
 */
@Module({
  imports: [AppConfigModule, BenchReportsModule, PlaytestModule],
  controllers: [HealthController],
})
export class AppModule {}
