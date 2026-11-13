import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { VipModule } from "../vip/vip.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { BattlePassController } from "./battle-pass.controller.js";
import { BATTLE_PASS_REPOSITORY, PrismaBattlePassRepository } from "./battle-pass.repository.js";
import { BattlePassService } from "./battle-pass.service.js";
import { PassAdminService } from "./pass-admin.service.js";
import { PASS_SEASON_REPOSITORY, PrismaPassSeasonRepository } from "./pass-season.repository.js";

/**
 * Батл-пасс (docs/35-stage4-plan.md Р46, §3.15; tasks/T-0311): месяц по Москве,
 * очки за задания, 30 ступеней в бесплатной и VIP-ленте. Награды — через кошелёк
 * (`pass_reward`) и подарки-бусты. Сервис экспортируется модулю заданий: он
 * прибавляет очки при заборе задания; сервис лент для панели (T-0313) —
 * модулю админки.
 */
@Module({
  imports: [AuthModule, WalletModule, VipModule],
  controllers: [BattlePassController],
  providers: [
    BattlePassService,
    PassAdminService,
    { provide: BATTLE_PASS_REPOSITORY, useClass: PrismaBattlePassRepository },
    { provide: PASS_SEASON_REPOSITORY, useClass: PrismaPassSeasonRepository },
  ],
  exports: [BattlePassService, PassAdminService],
})
export class BattlePassModule {}
