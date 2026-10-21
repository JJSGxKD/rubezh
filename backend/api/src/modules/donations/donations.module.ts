import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { DonationsController } from "./donations.controller.js";
import { DONATIONS_REPOSITORY, PrismaDonationsRepository } from "./donations.repository.js";
import { DonationsService } from "./donations.service.js";

/**
 * Донаты проекту (docs/35-stage4-plan.md, Р109): счёт на любую сумму в
 * пределах способа оплаты через модуль оплаты и знак «Поддержал проект»
 * на аккаунте. Выдачу знака и его снятие при внешнем возврате звёзд модуль
 * регистрирует в общих реестрах модуля оплаты, как магазин и VIP; донат по
 * ссылке Tribute с аккаунтом не связан, сервер лишь отдаёт ссылку.
 */
@Module({
  imports: [AuthModule, PaymentsModule, RestrictionsModule, SettingsModule],
  controllers: [DonationsController],
  providers: [DonationsService, { provide: DONATIONS_REPOSITORY, useClass: PrismaDonationsRepository }],
  exports: [DonationsService],
})
export class DonationsModule {}
