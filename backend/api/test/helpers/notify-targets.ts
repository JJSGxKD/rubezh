import type { AppConfig } from "../../src/config/app-config.js";
import { NotifyTargets } from "../../src/modules/settings/notify-targets.js";
import { environmentSettings } from "../../src/modules/settings/settings.service.js";

/** Адреса чатов команды только из окружения — как у процесса без записей в панели. */
export function targetsOf(config: AppConfig): NotifyTargets {
  return new NotifyTargets(environmentSettings(config));
}
