import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { FunnelTracker } from "./funnel-tracker.js";
import { FUNNEL_REPOSITORY, PrismaFunnelRepository } from "./funnel.repository.js";

/**
 * Воронка аккаунта (docs/35-stage4-plan.md, WP2): вехи с датой первого раза —
 * от входа в канал площадки до первой покупки. Источники о воронке не знают:
 * она слушает вход, забеги и оплату сама.
 */
@Module({
  imports: [AuthModule, RunsModule, PaymentsModule],
  providers: [FunnelTracker, { provide: FUNNEL_REPOSITORY, useClass: PrismaFunnelRepository }],
  // Карточке игрока в панели — вехи, воронке в панели — отчёт по источникам.
  exports: [FUNNEL_REPOSITORY],
})
export class FunnelModule {}
