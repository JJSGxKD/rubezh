import { SECRETS } from "../../modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../../modules/secrets/secrets.service.js";
import { SETTINGS } from "../../modules/settings/setting-catalog.js";
import type { SettingsReader } from "../../modules/settings/settings.service.js";
import type { ExternalLinkStarter } from "../ports/external-link.js";

/**
 * Ссылка на бота MAX с одноразовым кодом (docs/35-stage4-plan.md Р188,
 * tasks/T-0379): `https://max.ru/<имя бота>?start=<код>`. Игрок нажимает
 * «Начать», и бот получает код в событии `bot_started`. Ключ и имя читаются при
 * каждой ссылке: правка в панели действует без перезапуска. Нет любого из двух —
 * `null`: бот не ответит, и задания-каналы MAX игрокам других площадок не видны.
 */
export class MaxLinkStarter implements ExternalLinkStarter {
  readonly platform = "max" as const;

  constructor(
    private readonly secrets: Pick<SecretsReader, "get">,
    private readonly settings: Pick<SettingsReader, "get">,
  ) {}

  startUrl(code: string): string | null {
    if (this.secrets.get(SECRETS.maxBotToken) === null) return null;
    const username = this.settings.get(SETTINGS.maxBotUsername);
    if (username === "") return null;
    return `https://max.ru/${encodeURIComponent(username)}?start=${encodeURIComponent(code)}`;
  }
}
