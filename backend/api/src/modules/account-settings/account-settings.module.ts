import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AccountSettingsController } from "./account-settings.controller.js";
import { ACCOUNT_SETTINGS_REPOSITORY, PrismaAccountSettingsRepository } from "./account-settings.repository.js";
import { AccountSettingsService } from "./account-settings.service.js";

/**
 * Настройки аккаунта (docs/35-stage4-plan.md Р56, WP29): участие в помощи в
 * тестировании, усвоенные подсказки, отображение боя — с устройства на
 * устройство. Графика, громкость и вибрация остаются у устройства.
 */
@Module({
  imports: [AuthModule],
  controllers: [AccountSettingsController],
  providers: [AccountSettingsService, { provide: ACCOUNT_SETTINGS_REPOSITORY, useClass: PrismaAccountSettingsRepository }],
})
export class AccountSettingsModule {}
