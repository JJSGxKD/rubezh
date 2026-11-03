import type { PlatformId } from "../../platforms/ports/platform.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import type { SettingsReader } from "../settings/settings.service.js";

/**
 * Ссылка кнопки «Связаться с разработчиком» для площадки аккаунта
 * (docs/35-stage4-plan.md Р173). Переключение без `default`: новая площадка
 * обязана получить свой ключ, иначе не соберётся `typecheck`. Пусто — `null`.
 */
export function contactUrlFor(platform: PlatformId, settings: SettingsReader): string | null {
  const url = ((): string => {
    switch (platform) {
      case "telegram":
        return settings.get(SETTINGS.contactUrlTelegram);
      case "max":
        return settings.get(SETTINGS.contactUrlMax);
      case "vk":
        return settings.get(SETTINGS.contactUrlVk);
      case "web":
        return settings.get(SETTINGS.contactUrlWeb);
    }
  })();
  return url === "" ? null : url;
}
