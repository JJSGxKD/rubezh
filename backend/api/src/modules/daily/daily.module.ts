import { Module } from "@nestjs/common";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { DailyController } from "./daily.controller.js";
import { DailyDoubleService } from "./daily-double.service.js";
import { DAILY_DOUBLE_REPOSITORY, DAILY_REPOSITORY, PrismaDailyDoubleRepository, PrismaDailyRepository } from "./daily.repository.js";
import { DailyService } from "./daily.service.js";

/**
 * Награда дня (docs/35-stage4-plan.md Р45, WP13): неделя без сброса, ступени
 * недель, множитель уровня. Монеты и осколки кладёт кошелёк ключом дня.
 * Хозяин места рекламы `daily_double` (Р155): удвоение забранной награды за ролик.
 */
@Module({
  imports: [AdsModule, AuthModule, ProgressModule, RunsModule, WalletModule],
  controllers: [DailyController],
  providers: [
    DailyService,
    DailyDoubleService,
    { provide: DAILY_REPOSITORY, useClass: PrismaDailyRepository },
    { provide: DAILY_DOUBLE_REPOSITORY, useClass: PrismaDailyDoubleRepository },
  ],
  exports: [DailyService],
})
export class DailyModule {}
