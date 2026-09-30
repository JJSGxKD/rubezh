import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ShopController } from "./shop.controller.js";
import { ShopService } from "./shop.service.js";

/**
 * Магазин (docs/35-stage4-plan.md §3.6, WP10): каталог с фиксированным
 * составом (Р11), счёт через модуль оплаты и выдача журналом кошелька.
 */
@Module({
  imports: [AuthModule, PaymentsModule, WalletModule],
  controllers: [ShopController],
  providers: [ShopService],
  exports: [ShopService],
})
export class ShopModule {}
