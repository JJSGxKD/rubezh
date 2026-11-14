import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { IDENTITY_SOURCES, PublicIdentity, PublicIdentityModule } from "../../common/public-identity.js";
import { AchievementsModule } from "../achievements/achievements.module.js";
import { AchievementsService } from "../achievements/achievements.service.js";
import { EmblemsService } from "../achievements/emblems.service.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AuthModule } from "../auth/auth.module.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "../friends/friends.repository.js";
import { FriendsModule } from "../friends/friends.module.js";
import { ItemsModule } from "../items/items.module.js";
import { ItemsService } from "../items/items.service.js";
import { ProgressModule } from "../progress/progress.module.js";
import { ProgressService } from "../progress/progress.service.js";
import { RatingRestrictions } from "../runs/rating-restrictions.js";
import { RunsModule } from "../runs/runs.module.js";
import { RunsViewService } from "../runs/runs-view.service.js";
import { SeasonsModule } from "../seasons/seasons.module.js";
import { SeasonsViewService } from "../seasons/seasons-view.service.js";
import { VipModule } from "../vip/vip.module.js";
import { VipService } from "../vip/vip.service.js";
import { PlayersController } from "./players.controller.js";
import { PLAYER_SOURCES, PlayersService, type PlayerSources } from "./players.service.js";
import { publicIdSource } from "./public-id-source.js";

/**
 * Карточка игрока (docs/35-stage4-plan.md Р47, Р48, tasks/T-0247): публичная страница игрока по
 * публичному id. Модуль только собирает ответ из соседей — уровня, мощи, знаков, витрины,
 * забегов и места в сезоне, — своих таблиц у него нет.
 *
 * Он же подключает к порту `PublicIdentity` (T-0240) источник публичных id под именем `publicId`:
 * строки рейтинга, сезона и друзей получают id тем же вызовом, что знак и облик, и о карточке не
 * знают. Клиент — T-0248.
 */
@Module({
  controllers: [PlayersController],
  providers: [
    PlayersService,
    {
      provide: PLAYER_SOURCES,
      inject: [ACCOUNT_REPOSITORY, FRIENDS_REPOSITORY, RatingRestrictions, RunsViewService, SeasonsViewService, ProgressService, ItemsService, AchievementsService, EmblemsService, VipService, PublicIdentity],
      useFactory: (
        accounts: AccountRepository,
        friends: FriendsRepository,
        rating: RatingRestrictions,
        runs: RunsViewService,
        seasons: SeasonsViewService,
        progress: ProgressService,
        items: ItemsService,
        achievements: AchievementsService,
        emblems: EmblemsService,
        vip: VipService,
        identity: PublicIdentity,
      ): PlayerSources => ({ accounts, friends, rating, runs, seasons, progress, items, achievements, emblems, vip, identity }),
    },
  ],
})
export class PlayersModule implements OnModuleInit {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly identity: PublicIdentity,
  ) {}

  onModuleInit(): void {
    this.identity.provide(publicIdSource(this.accounts), IDENTITY_SOURCES.publicId);
  }
}
