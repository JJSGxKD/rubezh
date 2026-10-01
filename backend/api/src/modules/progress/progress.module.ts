import { Module } from "@nestjs/common";
import { AdsModule } from "../ads/ads.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { ItemsModule } from "../items/items.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ProgressController } from "./progress.controller.js";
import { PROGRESS_REPOSITORY, PrismaProgressRepository } from "./progress.repository.js";
import { ProgressService } from "./progress.service.js";
import { RunDoubleController } from "./run-double.controller.js";
import { PrismaRunDoubleRepository, RUN_DOUBLE_REPOSITORY } from "./run-double.repository.js";
import { RunDoubleService } from "./run-double.service.js";
import { RunRewardExtras } from "./run-reward-extras.js";
import { RunRewards } from "./run-rewards.js";

/**
 * Уровень аккаунта и награды за забег (docs/35-stage4-plan.md, WP4): слушатель
 * записанного забега ставит награду в очередь, кошелёк её начисляет, а
 * снаряжение выдаёт добычу. Удвоение монет за рекламу — место `run_double`
 * модуля рекламы (WP12).
 */
@Module({
  imports: [AuthModule, AdsModule, RunsModule, WalletModule, ItemsModule],
  controllers: [ProgressController, RunDoubleController],
  providers: [
    ProgressService,
    RunRewards,
    RunRewardExtras,
    RunDoubleService,
    { provide: PROGRESS_REPOSITORY, useClass: PrismaProgressRepository },
    { provide: RUN_DOUBLE_REPOSITORY, useClass: PrismaRunDoubleRepository },
  ],
  exports: [ProgressService],
})
export class ProgressModule {}
