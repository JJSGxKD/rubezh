import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FlagsModule } from "../flags/flags.module.js";
import { FlagsService } from "../flags/flags.service.js";
import { AdAudience } from "./ad-audience.js";
import { AD_CREATIVES, NetworkCreatives, TADDY_API } from "./ad-creatives.js";
import { AdNetworkKeys } from "./ad-network-keys.js";
import { ADS_CATALOG_REPOSITORY, PrismaAdsCatalogRepository } from "./ads-catalog.repository.js";
import { AdPasses } from "./ads-passes.js";
import { AdsCatalogService } from "./ads-catalog.service.js";
import { AdsController } from "./ads.controller.js";
import { ADS_REPOSITORY, PrismaAdsRepository } from "./ads.repository.js";
import { ADS_ROLL, AdsService, cryptoRoll } from "./ads.service.js";
import { INTERSTITIAL_FLAGS, InterstitialGate } from "./interstitial-gate.js";
import { HttpTaddyApi } from "./taddy-api.js";

/**
 * Реклама (docs/35-stage4-plan.md §3.7, WP12): сети и блоки мест, выбор
 * сети с часовой паузой и суточным кругом, сессия показа с воронкой и
 * растущий кулдаун награды. Хозяева мест забирают выполненные сессии через
 * экспортируемый `AdsService`; панель правит сети и блоки через
 * `AdsCatalogService`; VIP регистрирует пропуск рекламы в `AdPasses`.
 *
 * Сети с API (Taddy, Р78) отдают креатив серверу — `AD_CREATIVES`; ключи
 * всех сетей, включённых и нет, держит `AdNetworkKeys`; учёт аудитории
 * сетью — SDK на старте и запуск бота — `AdAudience`.
 *
 * Межстраничную пропускает `InterstitialGate`: момент площадки, доля флага
 * выката и частота из панели.
 */
@Module({
  imports: [AuthModule, FlagsModule],
  controllers: [AdsController],
  providers: [
    AdsService,
    AdsCatalogService,
    AdPasses,
    AdNetworkKeys,
    AdAudience,
    InterstitialGate,
    { provide: INTERSTITIAL_FLAGS, useExisting: FlagsService },
    { provide: AD_CREATIVES, useClass: NetworkCreatives },
    { provide: TADDY_API, useFactory: () => new HttpTaddyApi() },
    { provide: ADS_REPOSITORY, useClass: PrismaAdsRepository },
    { provide: ADS_CATALOG_REPOSITORY, useClass: PrismaAdsCatalogRepository },
    { provide: ADS_ROLL, useValue: cryptoRoll },
  ],
  exports: [AdsService, AdsCatalogService, AdPasses, AdAudience],
})
export class AdsModule {}
