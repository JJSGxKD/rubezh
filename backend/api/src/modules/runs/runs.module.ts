import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LEADERBOARD_STORE, RedisLeaderboardStore } from "./leaderboard.store.js";
import { RunsController } from "./runs.controller.js";
import { PrismaRunsRepository, RUNS_REPOSITORY } from "./runs.repository.js";
import { RunsService } from "./runs.service.js";
import { RunContinues } from "./run-continues.js";
import { RunLoadouts } from "./run-loadouts.js";
import { RunsHooks } from "./runs-hooks.js";
import { RunsViewService } from "./runs-view.service.js";

/**
 * Забеги под аккаунтом и рейтинг на них (docs/34-stage3-plan.md, WP4).
 *
 * Единственный приём забегов: плейтестовое хранилище снято вместе с
 * переездом клиента. Сводка плейтеста и уведомления в чат узнают о забегах
 * из `RunsHooks` и читают рейтинг — отсюда экспорт.
 */
@Module({
  imports: [AuthModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    RunsViewService,
    RunsHooks,
    RunContinues,
    RunLoadouts,
    { provide: RUNS_REPOSITORY, useClass: PrismaRunsRepository },
    { provide: LEADERBOARD_STORE, useClass: RedisLeaderboardStore },
  ],
  // Хуки, чтение и рейтинг — сводке плейтеста, карточке `/start` и
  // уведомлениям в чат: они читают забеги, но не принимают их. Сверку
  // продолжений подключает модуль оплаты, проверку снимка снаряжения — модуль
  // предметов.
  exports: [RunsService, RunsViewService, RunsHooks, RunContinues, RunLoadouts, RUNS_REPOSITORY, LEADERBOARD_STORE],
})
export class RunsModule {}
