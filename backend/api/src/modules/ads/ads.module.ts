import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdsController } from "./ads.controller.js";
import { ADS_REPOSITORY, PrismaAdsRepository } from "./ads.repository.js";
import { ADS_ROLL, AdsService, cryptoRoll } from "./ads.service.js";

/**
 * Реклама (docs/35-stage4-plan.md §3.7, WP12): сети и блоки мест, выбор
 * сети с часовой паузой и суточным кругом, сессия показа с воронкой и
 * растущий кулдаун награды. Хозяева мест забирают выполненные сессии через
 * экспортируемый `AdsService`.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdsController],
  providers: [AdsService, { provide: ADS_REPOSITORY, useClass: PrismaAdsRepository }, { provide: ADS_ROLL, useValue: cryptoRoll }],
  exports: [AdsService],
})
export class AdsModule {}
