import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { PromoCodesController } from "./promo-codes.controller.js";
import { PrismaPromoCodesRepository, PROMO_CODES_REPOSITORY } from "./promo-codes.repository.js";
import { PROMO_RANDOM, PromoCodesService, cryptoPick } from "./promo-codes.service.js";

/**
 * Промокоды (docs/35-stage4-plan.md WP41, Р74): ввод кода игроком, кампании
 * в панели, награда — журналом кошелька причиной `promo_reward`.
 */
@Module({
  imports: [AuthModule, WalletModule],
  controllers: [PromoCodesController],
  providers: [PromoCodesService, { provide: PROMO_CODES_REPOSITORY, useClass: PrismaPromoCodesRepository }, { provide: PROMO_RANDOM, useValue: cryptoPick }],
  exports: [PromoCodesService],
})
export class PromoCodesModule {}
