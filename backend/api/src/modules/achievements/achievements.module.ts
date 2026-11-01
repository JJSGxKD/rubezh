import { Module, type OnModuleInit } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FriendsModule } from "../friends/friends.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { RunPrestige } from "../runs/run-prestige.js";
import { RunsModule } from "../runs/runs.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { AchievementRarityJob } from "./achievement-rarity.job.js";
import { AchievementsController } from "./achievements.controller.js";
import { ACHIEVEMENTS_REPOSITORY, PrismaAchievementsRepository } from "./achievements.repository.js";
import { AchievementsService } from "./achievements.service.js";

/**
 * Достижения с престижем (docs/39-retention-mechanics.md К1, tasks/T-0106):
 * витрина, редкость «есть у N%» и три любимых. Определения, прогресс и забор —
 * в модуле заданий: достижение там та же строка каталога, забег двигает её тем же
 * слушателем. Число друзей и уровень аккаунта сервис читает у соседей при
 * открытии витрины.
 *
 * Рейтинг о достижениях не знает: модуль при старте подключает к порту забегов
 * `RunPrestige` (T-0107) `prestigeOf` — престиж пачки аккаунтов одним запросом.
 */
@Module({
  imports: [AuthModule, TasksModule, FriendsModule, ProgressModule, RunsModule],
  controllers: [AchievementsController],
  providers: [AchievementsService, AchievementRarityJob, { provide: ACHIEVEMENTS_REPOSITORY, useClass: PrismaAchievementsRepository }],
  exports: [AchievementsService],
})
export class AchievementsModule implements OnModuleInit {
  constructor(
    private readonly achievements: AchievementsService,
    private readonly runPrestige: RunPrestige,
  ) {}

  onModuleInit(): void {
    this.runPrestige.provide({ of: async (accountIds) => await this.achievements.prestigeOf(accountIds) });
  }
}
