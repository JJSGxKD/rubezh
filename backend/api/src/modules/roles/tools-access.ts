import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { RolesService, type AccountRef } from "./roles.service.js";

/** Та же форма, что `ToolsAccess` в `packages/shared-types`: бэкенд пакеты клиента не импортирует. */
export interface ToolsAccess {
  admin: boolean;
  stressTest: boolean;
  devMode: boolean;
}

/**
 * Что открыто игроку из инструментов команды (docs/28-diagnostics.md §2.3):
 * режим разработчика — по праву `tools.dev`, стресс-тест — ему же, а всем —
 * когда команда включила это в панели («Стресс-тест для всех игроков»). На
 * машине разработчика — всё. Скрытая кнопка не защита: приёмник отчётов
 * спрашивает то же правило сам.
 */
@Injectable()
export class ToolsAccessService {
  constructor(
    private readonly roles: RolesService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async forAccount(account: AccountRef): Promise<ToolsAccess> {
    const admin = await this.roles.can(account, "tools.dev");
    return { admin, stressTest: admin || this.stressForAll(), devMode: admin };
  }

  /**
   * Принять ли отчёт стресс-теста от этого запуска. Подпись запуска пока
   * только у Telegram, поэтому и идентификатор — его.
   */
  async stressTestOpen(platformUserId: string | null): Promise<boolean> {
    if (this.stressForAll()) return true;
    return platformUserId !== null && (await this.roles.canByPlatformUser("telegram", platformUserId, "tools.dev"));
  }

  private stressForAll(): boolean {
    return this.config.nodeEnv === "development" || this.settings.get(SETTINGS.stressForAll);
  }
}
