import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ADS_CATALOG_REPOSITORY, PrismaAdsCatalogRepository } from "./ads-catalog.repository.js";
import { AdPasses } from "./ads-passes.js";
import { AdsCatalogService } from "./ads-catalog.service.js";
import { AdsController } from "./ads.controller.js";
import { ADS_REPOSITORY, PrismaAdsRepository } from "./ads.repository.js";
import { ADS_ROLL, AdsService, cryptoRoll } from "./ads.service.js";

/**
 * Реклама (docs/35-stage4-plan.md §3.7, WP12): сети и блоки мест, выбор
 * сети с часовой паузой и суточным кругом, сессия показа с воронкой и
 * растущий кулдаун награды. Хозяева мест забирают выполненные сессии через
 * экспортируемый `AdsService`; панель правит сети и блоки через
 * `AdsCatalogService`; VIP регистрирует пропуск рекламы в `AdPasses`.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdsController],
  providers: [
    AdsService,
    AdsCatalogService,
    AdPasses,
    { provide: ADS_REPOSITORY, useClass: PrismaAdsRepository },
    { provide: ADS_CATALOG_REPOSITORY, useClass: PrismaAdsCatalogRepository },
    { provide: ADS_ROLL, useValue: cryptoRoll },
  ],
  exports: [AdsService, AdsCatalogService, AdPasses],
})
export class AdsModule {}
