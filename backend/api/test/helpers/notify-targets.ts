import type { AppConfig } from "../../src/config/app-config.js";
import { FeatureSwitches } from "../../src/modules/settings/feature-switches.js";
import { NotifyTargets } from "../../src/modules/settings/notify-targets.js";
import { environmentSettings } from "../../src/modules/settings/settings.service.js";

/** Адреса чатов команды только из окружения — как у процесса без записей в панели. */
export function targetsOf(config: AppConfig): NotifyTargets {
  return new NotifyTargets(environmentSettings(config));
}

/** Выключатели функций только из окружения — как у процесса без записей в панели. */
export function switchesOf(config: AppConfig): FeatureSwitches {
  return new FeatureSwitches(environmentSettings(config), config);
}
