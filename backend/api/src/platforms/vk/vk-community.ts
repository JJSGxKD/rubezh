import { SECRETS } from "../../modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../../modules/secrets/secrets.service.js";
import { SETTINGS, parseVkCommunity, type VkCommunityRef } from "../../modules/settings/setting-catalog.js";
import type { SettingsReader } from "../../modules/settings/settings.service.js";

/**
 * Сообщество VK, которое служит ботом для заданий (docs/35-stage4-plan.md
 * Р188, tasks/T-0378): ключ доступа, секрет и строка подтверждения Callback
 * API — из «Ключей интеграций», само сообщество — из настройки `vk.community`.
 *
 * Читает значения в момент вызова, а не при старте: панель меняет их без
 * релиза, и ссылка для игрока обязана следовать за настройкой.
 */
export class VkCommunity {
  constructor(
    private readonly secrets: SecretsReader,
    private readonly settings: Pick<SettingsReader, "get">,
  ) {}

  /** Ключ доступа сообщества; `null` — не задан: бота нет. */
  token(): string | null {
    return this.secrets.get(SECRETS.vkCommunityToken);
  }

  /** Секрет Callback API; `null` — не создан: вебхук для внешнего мира закрыт. */
  callbackSecret(): string | null {
    return this.secrets.get(SECRETS.vkCallbackSecret);
  }

  /** Строка, которую VK просит вернуть при подключении адреса. */
  confirmation(): string | null {
    return this.secrets.get(SECRETS.vkCallbackConfirmation);
  }

  /** Сообщество из настройки; `null` — не задано или записано не так, как положено. */
  ref(): VkCommunityRef | null {
    return parseVkCommunity(this.settings.get(SETTINGS.vkCommunity));
  }
}
