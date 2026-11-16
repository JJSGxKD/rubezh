import { Module } from "@nestjs/common";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { FriendsModule } from "../friends/friends.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { PrismaVipGiftRepository, VIP_GIFT_REPOSITORY } from "./vip-gift.repository.js";
import { VipGiftService } from "./vip-gift.service.js";
import { VipController } from "./vip.controller.js";
import { PrismaVipRepository, VIP_REPOSITORY } from "./vip.repository.js";
import { VipService } from "./vip.service.js";

/**
 * VIP (docs/35-stage4-plan.md §3.6, Р20, Р26, Р44; WP10): подписка площадки
 * через модуль оплаты, журнал оплаченных периодов и самоцветы дня. Надбавку
 * к наградам и пропуск рекламы VIP регистрирует сам — в кошельке и в модуле
 * рекламы, и те о VIP не знают.
 *
 * VIP в подарок другу (Р155, T-0249) — рядом: свой срок получателя, заказ за звёзды,
 * выдача и возврат через модуль оплаты; друзья — только чтение дружбы, лента —
 * уведомление получателю.
 */
@Module({
  imports: [AuthModule, PaymentsModule, WalletModule, AdsModule, RestrictionsModule, FriendsModule, NotificationsModule],
  controllers: [VipController],
  providers: [VipService, VipGiftService, { provide: VIP_REPOSITORY, useClass: PrismaVipRepository }, { provide: VIP_GIFT_REPOSITORY, useClass: PrismaVipGiftRepository }],
  exports: [VipService],
})
export class VipModule {}
