import { Module } from "@nestjs/common";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { LEADERBOARD_STORE, RedisLeaderboardStore } from "./leaderboard.store.js";
import { RatingRestrictions } from "./rating-restrictions.js";
import { RunsController } from "./runs.controller.js";
import { PrismaRunsRepository, RUNS_REPOSITORY } from "./runs.repository.js";
import { RunsService } from "./runs.service.js";
import { RunAdContinueController } from "./run-ad-continue.controller.js";
import { RunAdContinueService } from "./run-ad-continue.service.js";
import { PrismaRunAdContinuesRepository, RUN_AD_CONTINUES_REPOSITORY } from "./run-ad-continues.repository.js";
import { RunContinues } from "./run-continues.js";
import { RunExtras } from "./run-details.js";
import { RunGemContinueController } from "./run-gem-continue.controller.js";
import { RunGemContinueService } from "./run-gem-continue.service.js";
import { PrismaRunGemContinuesRepository, RUN_GEM_CONTINUES_REPOSITORY } from "./run-gem-continues.repository.js";
import { RunLoadouts } from "./run-loadouts.js";
import { RunProofsCleanupJob } from "./run-proofs-cleanup.job.js";
import { PrismaRunProofsRepository, RUN_PROOFS_REPOSITORY } from "./run-proofs.repository.js";
import { RunProofsService } from "./run-proofs.service.js";
import { RunsHooks } from "./runs-hooks.js";
import { RunsViewService } from "./runs-view.service.js";

/**
 * Забеги под аккаунтом и рейтинг на них (docs/34-stage3-plan.md, WP4).
 *
 * Единственный приём забегов: плейтестовое хранилище снято вместе с
 * переездом клиента. Забег — хозяин места рекламы «второй шанс» (WP11):
 * продолжение за рекламу выдаётся здесь, по сессии модуля рекламы. Второй
 * шанс за самоцветы (Р162) — тоже здесь: покупка списывает самоцветы
 * кошелька и записывает продолжение одной транзакцией. Сводка плейтеста и
 * уведомления в чат узнают о забегах из `RunsHooks` и читают рейтинг — отсюда
 * экспорт.
 */
@Module({
  imports: [AuthModule, AdsModule, RestrictionsModule, WalletModule],
  controllers: [RunsController, RunAdContinueController, RunGemContinueController],
  providers: [
    RunsService,
    RunsViewService,
    RunsHooks,
    RunContinues,
    RunAdContinueService,
    RunGemContinueService,
    RunLoadouts,
    RunExtras,
    RatingRestrictions,
    RunProofsService,
    RunProofsCleanupJob,
    { provide: RUN_PROOFS_REPOSITORY, useClass: PrismaRunProofsRepository },
    { provide: RUNS_REPOSITORY, useClass: PrismaRunsRepository },
    { provide: RUN_AD_CONTINUES_REPOSITORY, useClass: PrismaRunAdContinuesRepository },
    { provide: RUN_GEM_CONTINUES_REPOSITORY, useClass: PrismaRunGemContinuesRepository },
    { provide: LEADERBOARD_STORE, useClass: RedisLeaderboardStore },
  ],
  // Хуки, чтение и рейтинг — сводке плейтеста, карточке `/start` и
  // уведомлениям в чат: они читают забеги, но не принимают их. Сверку
  // продолжений подключает модуль оплаты, проверку снимка снаряжения — модуль
  // предметов; награду, бусты и добычу в листе забега — их модули.
  exports: [RunsService, RunsViewService, RunsHooks, RunContinues, RunLoadouts, RunExtras, RUNS_REPOSITORY, LEADERBOARD_STORE],
})
export class RunsModule {}
