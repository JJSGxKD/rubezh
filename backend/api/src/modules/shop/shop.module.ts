import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ItemsModule } from "../items/items.module.js";
import { cryptoSeeds } from "../items/items.service.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ShopController } from "./shop.controller.js";
import { ShopService } from "./shop.service.js";
import { PrismaShowcaseRepository, SHOWCASE_REPOSITORY } from "./showcase.repository.js";
import { SHOWCASE_SEEDS, ShowcaseService } from "./showcase.service.js";

/**
 * Магазин (docs/35-stage4-plan.md §3.6, WP10): каталог с фиксированным
 * составом (Р11), счёт через модуль оплаты и выдача журналом кошелька;
 * витрина снаряжения — покупка за самоцветы через модуль предметов.
 */
@Module({
  imports: [AuthModule, PaymentsModule, WalletModule, ItemsModule],
  controllers: [ShopController],
  providers: [
    ShopService,
    ShowcaseService,
    { provide: SHOWCASE_REPOSITORY, useClass: PrismaShowcaseRepository },
    { provide: SHOWCASE_SEEDS, useValue: cryptoSeeds },
  ],
  exports: [ShopService],
})
export class ShopModule {}
