import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { TasksController } from "./tasks.controller.js";
import { PrismaTasksRepository, TASKS_REPOSITORY } from "./tasks.repository.js";
import { TasksService } from "./tasks.service.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): каталог в базе,
 * прогресс от записанных забегов, награда — кошельком по ключу задания и
 * срока. Сервис экспортируется знакам меню и панели.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule],
  controllers: [TasksController],
  providers: [TasksService, { provide: TASKS_REPOSITORY, useClass: PrismaTasksRepository }],
  exports: [TasksService],
})
export class TasksModule {}
