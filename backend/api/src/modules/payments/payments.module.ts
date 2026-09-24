import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { PrismaPurchasesRepository, PURCHASES_REPOSITORY } from "./purchases.repository.js";

/**
 * Второй шанс за Telegram Stars (docs/34-stage3-plan.md, WP5): цена, счёт и
 * состояние покупки. Выключен по умолчанию (`PAYMENTS_ENABLED`).
 *
 * Забеги модуль читает, но не принимает: продолжение продаётся к забегу,
 * который начался на сервере, — отсюда зависимость от `RunsModule`, а не
 * наоборот.
 */
@Module({
  imports: [AuthModule, RunsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, { provide: PURCHASES_REPOSITORY, useClass: PrismaPurchasesRepository }],
})
export class PaymentsModule {}
