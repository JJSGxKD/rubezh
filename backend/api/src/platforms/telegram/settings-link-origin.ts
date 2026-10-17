import { SETTINGS, telegramLinkOriginOf } from "../../modules/settings/setting-catalog.js";
import type { SettingsReader } from "../../modules/settings/settings.service.js";
import { DEFAULT_LINK_ORIGIN, type LinkOrigin } from "./telegram-link-format.js";

/**
 * Домен ссылок из настройки `telegram.link-host` (Р100). Спрашивается при
 * каждой сборке ссылки: смена в панели действует без перезапуска. Значение,
 * не прошедшее проверку, до ссылки не доходит — работает домен по умолчанию.
 */
export class SettingsLinkOrigin implements LinkOrigin {
  constructor(private readonly settings: Pick<SettingsReader, "get">) {}

  origin(): string {
    return telegramLinkOriginOf(this.settings.get(SETTINGS.telegramLinkHost)) ?? DEFAULT_LINK_ORIGIN;
  }
}
