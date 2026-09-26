import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ItemsModule } from "../items/items.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ProgressController } from "./progress.controller.js";
import { PROGRESS_REPOSITORY, PrismaProgressRepository } from "./progress.repository.js";
import { ProgressService } from "./progress.service.js";
import { RunRewards } from "./run-rewards.js";

/**
 * Уровень аккаунта и награды за забег (docs/35-stage4-plan.md, WP4): слушатель
 * записанного забега ставит награду в очередь, кошелёк её начисляет, а
 * снаряжение выдаёт добычу.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, ItemsModule],
  controllers: [ProgressController],
  providers: [ProgressService, RunRewards, { provide: PROGRESS_REPOSITORY, useClass: PrismaProgressRepository }],
  exports: [ProgressService],
})
export class ProgressModule {}
