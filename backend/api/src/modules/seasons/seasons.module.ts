import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FriendsModule } from "../friends/friends.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { SeasonCloseJob } from "./season-close.job.js";
import { RedisSeasonBoardStore, SEASON_BOARD_STORE } from "./season-board.store.js";
import { PrismaSeasonsAdminRepository, SEASONS_ADMIN_REPOSITORY } from "./seasons-admin.repository.js";
import { SeasonsAdminService } from "./seasons-admin.service.js";
import { SeasonsClaimService } from "./seasons-claim.service.js";
import { PrismaSeasonCloseRepository, SEASON_CLOSE_REPOSITORY } from "./seasons-close.repository.js";
import { SeasonsCloseService } from "./seasons-close.service.js";
import { SeasonsProjection } from "./seasons-projection.js";
import { SeasonSchedule } from "./seasons-schedule.js";
import { SeasonsViewService } from "./seasons-view.service.js";
import { SeasonsController } from "./seasons.controller.js";
import { PrismaSeasonsRepository, SEASONS_REPOSITORY } from "./seasons.repository.js";

/**
 * Недельный сезон рейтинга (docs/39-retention-mechanics.md, Р1; tasks/T-0110):
 * таблица недели по сложностям, закрытие по понедельникам (UTC), награды за
 * порог и за место, таблица друзей, история. Включается ключом
 * `seasons.start-date` в настройках: пока он пуст, слушатель забегов выключен,
 * закрытие ничего не делает, а ручки отвечают «сезонов нет».
 *
 * Вечный рейтинг (`runs/leaderboard.store.ts`) не затронут: недельная таблица
 * живёт рядом, не вместо него. Модуль забегов о сезонах не знает — слушатели
 * подписываются сами.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, FriendsModule, RestrictionsModule],
  controllers: [SeasonsController],
  providers: [
    SeasonSchedule,
    SeasonsProjection,
    SeasonsViewService,
    SeasonsAdminService,
    SeasonsClaimService,
    SeasonsCloseService,
    SeasonCloseJob,
    { provide: SEASON_BOARD_STORE, useClass: RedisSeasonBoardStore },
    { provide: SEASONS_REPOSITORY, useClass: PrismaSeasonsRepository },
    { provide: SEASON_CLOSE_REPOSITORY, useClass: PrismaSeasonCloseRepository },
    { provide: SEASONS_ADMIN_REPOSITORY, useClass: PrismaSeasonsAdminRepository },
  ],
  // Расписание нужно ленте событий (рекорд недели по текущему сезону, tasks/T-0174),
  // а расписание и таблицу недели читают напоминания бота (`modules/reminders`, tasks/T-0128).
  // Рейтинг в панели (tasks/T-0380) читает `AdminModule`: контроллер там, сервис здесь.
  exports: [SeasonsProjection, SeasonSchedule, SEASON_BOARD_STORE, SeasonsAdminService],
})
export class SeasonsModule {}
