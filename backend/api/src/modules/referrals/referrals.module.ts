import { Module } from "@nestjs/common";
import { AttributionModule } from "../attribution/attribution.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { FriendsModule } from "../friends/friends.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ReferralsController } from "./referrals.controller.js";
import { PrismaReferralsRepository, REFERRALS_REPOSITORY } from "./referrals.repository.js";
import { ReferralsService } from "./referrals.service.js";

/**
 * Рефералка (docs/35-stage4-plan.md, WP14): привязка по ссылке дружбы,
 * активация по забегам, награды через кошелёк. Модули входа, забегов и
 * дружбы о ней не знают — она подписывается сама.
 */
@Module({
  imports: [AuthModule, AttributionModule, FriendsModule, RunsModule, WalletModule],
  controllers: [ReferralsController],
  providers: [ReferralsService, { provide: REFERRALS_REPOSITORY, useClass: PrismaReferralsRepository }],
})
export class ReferralsModule {}
