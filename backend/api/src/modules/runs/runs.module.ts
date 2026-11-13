import { Module } from "@nestjs/common";
import { PublicIdentityModule } from "../../common/public-identity.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { EventsModule } from "../events/events.module.js";
import { RatingModule } from "../rating/rating.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { LEADERBOARD_STORE, RedisLeaderboardStore } from "./leaderboard.store.js";
import { PROLOGUE_STORE, PrologueService, PrismaPrologueStore } from "./prologue.service.js";
import { LeaderboardWarmup } from "./leaderboard-warmup.js";
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
import { RunPrestige } from "./run-prestige.js";
import { RunProofsCleanupJob } from "./run-proofs-cleanup.job.js";
import { PrismaRunProofsRepository, RUN_PROOFS_REPOSITORY } from "./run-proofs.repository.js";
import { RunProofsService } from "./run-proofs.service.js";
import { ModuleRefSeasonPlaces, REPLAY_SEASON_PLACES, RunReplayFacts } from "./run-replay-facts.js";
import { BullReplayQueue, RunReplayJob } from "./run-replay.job.js";
import { PrismaRunReplayRepository, RUN_REPLAY_REPOSITORY } from "./run-replay.repository.js";
import { REPLAY_QUEUE, RUN_REPLAY_FACTS, RunReplayService } from "./run-replay.service.js";
import { PrismaRunReviewRepository, RUN_REVIEW_REPOSITORY } from "./run-review.repository.js";
import { RunReviewService } from "./run-review.service.js";
import { RunsHooks } from "./runs-hooks.js";
import { RunsViewService } from "./runs-view.service.js";

/**
 * Забеги под аккаунтом и рейтинг на них (docs/34-stage3-plan.md, WP4).
 *
 * Единственный приём забегов: плейтестовое хранилище снято вместе с
 * переездом клиента. Забег — хозяин места рекламы «второй шанс» (WP11):
 * продолжение за рекламу выдаётся здесь, по сессии модуля рекламы. Второй
 * шанс за самоцветы (Р162) — тоже здесь: покупка списывает самоцветы
 * кошелька и записывает продолжение одной транзакцией. Пролог первого забега
 * (Р151, T-0279) — тоже здесь: признак «пролог пройден» и награда за победу;
 * закрытые до победы разделы спрашивают его экспортом. Сводка плейтеста и
 * уведомления в чат узнают о забегах из `RunsHooks` и читают рейтинг — отсюда
 * экспорт.
 */
@Module({
  imports: [AuthModule, AdsModule, RestrictionsModule, WalletModule, RatingModule, PublicIdentityModule, EventsModule],
  controllers: [RunsController, RunAdContinueController, RunGemContinueController],
  providers: [
    RunsService,
    RunsViewService,
    RunReviewService,
    RunsHooks,
    PrologueService,
    { provide: PROLOGUE_STORE, useClass: PrismaPrologueStore },
    RunContinues,
    RunAdContinueService,
    RunGemContinueService,
    RunLoadouts,
    RunPrestige,
    RunExtras,
    RatingRestrictions,
    LeaderboardWarmup,
    RunProofsService,
    RunProofsCleanupJob,
    { provide: RUN_PROOFS_REPOSITORY, useClass: PrismaRunProofsRepository },
    // Перепроверка повтором (T-0319): сервис, расписание, факты о месте в досках и очередь в `sim-worker`.
    RunReplayService,
    RunReplayJob,
    RunReplayFacts,
    ModuleRefSeasonPlaces,
    { provide: RUN_REPLAY_REPOSITORY, useClass: PrismaRunReplayRepository },
    { provide: RUN_REPLAY_FACTS, useExisting: RunReplayFacts },
    { provide: REPLAY_SEASON_PLACES, useExisting: ModuleRefSeasonPlaces },
    { provide: REPLAY_QUEUE, useFactory: (config: AppConfig) => new BullReplayQueue(config), inject: [APP_CONFIG] },
    { provide: RUNS_REPOSITORY, useClass: PrismaRunsRepository },
    { provide: RUN_REVIEW_REPOSITORY, useClass: PrismaRunReviewRepository },
    { provide: RUN_AD_CONTINUES_REPOSITORY, useClass: PrismaRunAdContinuesRepository },
    { provide: RUN_GEM_CONTINUES_REPOSITORY, useClass: PrismaRunGemContinuesRepository },
    { provide: LEADERBOARD_STORE, useClass: RedisLeaderboardStore },
  ],
  // Хуки, чтение и рейтинг — сводке плейтеста, карточке `/start` и
  // уведомлениям в чат: они читают забеги, но не принимают их. Сверку
  // продолжений подключает модуль оплаты, проверку снимка снаряжения — модуль
  // предметов, престиж в строках рейтинга — модуль достижений (знак у имени — через общий порт `PublicIdentity`); награду, бусты и добычу в листе забега — их модули.
  // Отчёт забега и решения разбора (Р203) — ручкам панели: контроллер живёт в модуле панели, ему сервис нужен экспортом.
  // Перепроверка повтором: исход в очереди разбора и «Повторить снова» — там же (T-0319); награды после проверки (T-0320) зовут её отсюда.
  exports: [RunsService, RunsViewService, RunReviewService, RunReplayService, RunsHooks, PrologueService, RunContinues, RunLoadouts, RunPrestige, RunExtras, RatingRestrictions, RUNS_REPOSITORY, LEADERBOARD_STORE],
})
export class RunsModule {}
