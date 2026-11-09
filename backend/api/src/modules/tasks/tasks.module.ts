import { Module } from "@nestjs/common";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { BattlePassModule } from "../battle-pass/battle-pass.module.js";
import { MediaModule } from "../media/media.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ChannelWatchJob } from "./channel-watch.job.js";
import { CHANNEL_WATCH_REPOSITORY, PrismaChannelWatchRepository } from "./channel-watch.repository.js";
import { ChannelWatchService } from "./channel-watch.service.js";
import { TasksController } from "./tasks.controller.js";
import { NETWORK_TASKS_REPOSITORY, PrismaNetworkTasksRepository } from "./network-tasks.repository.js";
import { NetworkTasksService } from "./network-tasks.service.js";
import { PrismaTaskPointsRepository, TASK_POINTS_REPOSITORY } from "./task-points.repository.js";
import { TaskPointsService } from "./task-points.service.js";
import { PrismaTasksRepository, TASKS_REPOSITORY } from "./tasks.repository.js";
import { TasksService } from "./tasks.service.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): каталог в базе,
 * прогресс от записанных забегов, награда — кошельком по ключу задания и
 * срока. Сервис экспортируется знакам меню и панели.
 *
 * Очки заданий (T-0105) — `TaskPointsService`: полоса дня и недели и награды
 * за ступени; знак меню берёт готовые ступени через фасад `TasksService`.
 *
 * Очки батл-пасса (T-0311) забранное задание прибавляет через `BattlePassService`.
 *
 * Задания рекламных сетей (WP13, часть 6) — `NetworkTasksService`: модуль
 * заданий — хозяин места `task`, сколько заданий сети и какая награда за
 * них, решает он.
 *
 * Перепроверка подписки после награды (Р115, T-0178) — `ChannelWatchService` и
 * его расписание `ChannelWatchJob`: наружу они не выходят, службу окон зовёт
 * только забор награды из `TasksService`.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, AdsModule, MediaModule, RestrictionsModule, BattlePassModule, NotificationsModule],
  controllers: [TasksController],
  providers: [
    TasksService,
    TaskPointsService,
    NetworkTasksService,
    ChannelWatchService,
    ChannelWatchJob,
    { provide: CHANNEL_WATCH_REPOSITORY, useClass: PrismaChannelWatchRepository },
    { provide: TASKS_REPOSITORY, useClass: PrismaTasksRepository },
    { provide: TASK_POINTS_REPOSITORY, useClass: PrismaTaskPointsRepository },
    { provide: NETWORK_TASKS_REPOSITORY, useClass: PrismaNetworkTasksRepository },
  ],
  exports: [TasksService, NetworkTasksService],
})
export class TasksModule {}
