import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health/health.controller";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md) — пока только health-check как скелет.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController],
})
export class AppModule {}
