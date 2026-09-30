import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { VipController } from "./vip.controller.js";
import { PrismaVipRepository, VIP_REPOSITORY } from "./vip.repository.js";
import { VipService } from "./vip.service.js";

/**
 * VIP (docs/35-stage4-plan.md §3.6, Р20, Р26, Р44; WP10): подписка площадки
 * через модуль оплаты, журнал оплаченных периодов и самоцветы дня. Сервис
 * отдаётся наружу: без рекламы и увеличенные награды проверяют VIP там, где
 * их выдают.
 */
@Module({
  imports: [AuthModule, PaymentsModule, WalletModule],
  controllers: [VipController],
  providers: [VipService, { provide: VIP_REPOSITORY, useClass: PrismaVipRepository }],
  exports: [VipService],
})
export class VipModule {}
