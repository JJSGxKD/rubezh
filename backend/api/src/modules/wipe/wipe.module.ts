import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { CompensationController } from "./compensation.controller.js";
import { COMPENSATION_REPOSITORY, PrismaCompensationRepository } from "./compensation.repository.js";
import { CompensationService } from "./compensation.service.js";

/**
 * Вайп и компенсация тестерам (docs/35-stage4-plan.md Р87, WP33): выдача
 * компенсации по кнопке — `/api/v1/me/compensation`. Снимок перед вайпом и сам
 * вайп — служебные скрипты (`tester-snapshot.ts`, `wipe-runner.ts`), модулю
 * приложения не принадлежат.
 */
@Module({
  imports: [AuthModule, WalletModule],
  controllers: [CompensationController],
  providers: [CompensationService, { provide: COMPENSATION_REPOSITORY, useClass: PrismaCompensationRepository }],
})
export class WipeModule {}
