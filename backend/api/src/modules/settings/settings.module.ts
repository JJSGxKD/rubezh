import { Global, Module } from "@nestjs/common";
import { FeatureSwitches } from "./feature-switches.js";
import { NotifyTargets } from "./notify-targets.js";
import { PrismaSettingsRepository, SETTINGS_REPOSITORY } from "./settings.repository.js";
import { SETTINGS_READER, SettingsService } from "./settings.service.js";

/**
 * Настройки без релиза (WP24, docs/35-stage4-plan.md §3.18).
 *
 * Модуль глобальный, как конфигурация: настройки читают и модули домена, и
 * адаптеры площадок, а импорт в каждом модуле ничего не добавил бы. Права и
 * аудит записи — в панели (`admin-settings.service.ts`), здесь только
 * хранение и чтение.
 */
@Global()
@Module({
  providers: [
    SettingsService,
    { provide: SETTINGS_READER, useExisting: SettingsService },
    { provide: SETTINGS_REPOSITORY, useClass: PrismaSettingsRepository },
    NotifyTargets,
    FeatureSwitches,
  ],
  exports: [SettingsService, SETTINGS_READER, NotifyTargets, FeatureSwitches],
})
export class SettingsModule {}
