import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { DailyController } from "./daily.controller.js";
import { DAILY_REPOSITORY, PrismaDailyRepository } from "./daily.repository.js";
import { DailyService } from "./daily.service.js";

/**
 * Награда дня (docs/35-stage4-plan.md Р45, WP13): неделя без сброса, ступени
 * недель, множитель уровня. Монеты и осколки кладёт кошелёк ключом дня.
 */
@Module({
  imports: [AuthModule, ProgressModule, WalletModule],
  controllers: [DailyController],
  providers: [DailyService, { provide: DAILY_REPOSITORY, useClass: PrismaDailyRepository }],
  exports: [DailyService],
})
export class DailyModule {}
