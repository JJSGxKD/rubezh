import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { BoostsCheck } from "./boosts-check.js";
import { BoostsRunExtras } from "./boosts-run-extras.js";
import { BoostsController } from "./boosts.controller.js";
import { BoostsRefunder } from "./boosts-refunder.js";
import { BOOSTS_REPOSITORY, PrismaBoostsRepository } from "./boosts.repository.js";
import { BoostsService } from "./boosts.service.js";

/**
 * Бусты на забег (docs/35-stage4-plan.md §3.5, Р39): каталог, покупка до
 * старта, возврат несостоявшемуся забегу и сверка в итоге — её модуль
 * подключает к забегам сам (`boosts-check.ts`).
 */
@Module({
  imports: [AuthModule, WalletModule, RunsModule, NotificationsModule],
  controllers: [BoostsController],
  providers: [BoostsService, BoostsCheck, BoostsRunExtras, BoostsRefunder, { provide: BOOSTS_REPOSITORY, useClass: PrismaBoostsRepository }],
})
export class BoostsModule {}
