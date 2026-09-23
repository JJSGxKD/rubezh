import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LEADERBOARD_STORE, RedisLeaderboardStore } from "./leaderboard.store.js";
import { RunsController } from "./runs.controller.js";
import { PrismaRunsRepository, RUNS_REPOSITORY } from "./runs.repository.js";
import { RunsService } from "./runs.service.js";
import { RunsHooks } from "./runs-hooks.js";
import { RunsViewService } from "./runs-view.service.js";

/**
 * Забеги под аккаунтом и рейтинг на них (docs/34-stage3-plan.md, WP4).
 *
 * Живёт рядом с плейтестом, а не вместо него: клиент переезжает на модуль
 * отдельным шагом, и до тех пор плейтест продолжает принимать забеги. Снос
 * плейтестового хранилища — вместе с переездом клиента.
 */
@Module({
  imports: [AuthModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    RunsViewService,
    RunsHooks,
    { provide: RUNS_REPOSITORY, useClass: PrismaRunsRepository },
    { provide: LEADERBOARD_STORE, useClass: RedisLeaderboardStore },
  ],
  // Хуки, чтение и рейтинг — сводке плейтеста, карточке `/start` и
  // уведомлениям в чат: они читают забеги, но не принимают их.
  exports: [RunsService, RunsViewService, RunsHooks, RUNS_REPOSITORY, LEADERBOARD_STORE],
})
export class RunsModule {}
