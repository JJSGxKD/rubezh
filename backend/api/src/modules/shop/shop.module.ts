import { Module } from "@nestjs/common";
import { APPEARANCE_GRANTS_REPOSITORY, PrismaAppearanceGrantsRepository } from "../appearance/appearance-grants.repository.js";
import { AuthModule } from "../auth/auth.module.js";
import { ItemsModule } from "../items/items.module.js";
import { cryptoSeeds } from "../items/items.service.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { KEEPER_FIRST_WIN_REPOSITORY, KeeperSet, PrismaFirstWinRepository } from "./keeper-set.js";
import { ShopController } from "./shop.controller.js";
import { PrismaShopPromoRepository, SHOP_PROMO_REPOSITORY } from "./shop-promo.repository.js";
import { ShopPromoService } from "./shop-promo.service.js";
import { ShopChoice } from "./shop-choice.js";
import { PrismaShopOverrideRepository, SHOP_OVERRIDE_REPOSITORY, ShopOverrides } from "./shop-overrides.js";
import { ShopService } from "./shop.service.js";
import { PrismaShowcaseRepository, SHOWCASE_REPOSITORY } from "./showcase.repository.js";
import { SHOWCASE_SEEDS, ShowcaseService } from "./showcase.service.js";

/**
 * Магазин (docs/35-stage4-plan.md §3.6, WP10): каталог с фиксированным
 * составом (Р11), счёт через модуль оплаты и выдача журналом кошелька;
 * витрина снаряжения — покупка за самоцветы через модуль предметов; акции —
 * скидка от цены каталога на срок, заводятся в панели; правки цен и состава
 * поверх каталога кладёт только подтверждённая заявка (T-0309, `change-requests/`).
 * «Набор хранителя» (T-0245) — товар с окном в 48 часов после первой победы над Рубежом: окно
 * читает `KeeperSet`, а окрас из состава выдаётся строкой `appearance_grant` — репозиторий
 * выдач подключён здесь же своим экземпляром, как и в модуле обликов, чтобы магазин не тянул
 * за собой модуль заданий.
 */
@Module({
  imports: [AuthModule, PaymentsModule, WalletModule, ItemsModule, RestrictionsModule],
  controllers: [ShopController],
  providers: [
    ShopService,
    ShopChoice,
    ShopOverrides,
    { provide: SHOP_OVERRIDE_REPOSITORY, useClass: PrismaShopOverrideRepository },
    KeeperSet,
    { provide: KEEPER_FIRST_WIN_REPOSITORY, useClass: PrismaFirstWinRepository },
    { provide: APPEARANCE_GRANTS_REPOSITORY, useClass: PrismaAppearanceGrantsRepository },
    ShopPromoService,
    { provide: SHOP_PROMO_REPOSITORY, useClass: PrismaShopPromoRepository },
    ShowcaseService,
    { provide: SHOWCASE_REPOSITORY, useClass: PrismaShowcaseRepository },
    { provide: SHOWCASE_SEEDS, useValue: cryptoSeeds },
  ],
  exports: [ShopService, ShopPromoService, ShopOverrides],
})
export class ShopModule {}
