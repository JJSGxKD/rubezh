import { Module } from "@nestjs/common";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { MediaModule } from "../media/media.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { TasksController } from "./tasks.controller.js";
import { NETWORK_TASKS_REPOSITORY, PrismaNetworkTasksRepository } from "./network-tasks.repository.js";
import { NetworkTasksService } from "./network-tasks.service.js";
import { PrismaTasksRepository, TASKS_REPOSITORY } from "./tasks.repository.js";
import { TasksService } from "./tasks.service.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): каталог в базе,
 * прогресс от записанных забегов, награда — кошельком по ключу задания и
 * срока. Сервис экспортируется знакам меню и панели.
 *
 * Задания рекламных сетей (WP13, часть 6) — `NetworkTasksService`: модуль
 * заданий — хозяин места `task`, сколько заданий сети и какая награда за
 * них, решает он.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, AdsModule, MediaModule, RestrictionsModule],
  controllers: [TasksController],
  providers: [
    TasksService,
    NetworkTasksService,
    { provide: TASKS_REPOSITORY, useClass: PrismaTasksRepository },
    { provide: NETWORK_TASKS_REPOSITORY, useClass: PrismaNetworkTasksRepository },
  ],
  exports: [TasksService, NetworkTasksService],
})
export class TasksModule {}
