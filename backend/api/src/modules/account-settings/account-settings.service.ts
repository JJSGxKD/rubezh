import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { AccountRef } from "../roles/roles.service.js";
import { ACCOUNT_SETTINGS_VERSION, mergeSettings, readStored, type AccountSettingValue, type AccountSettingValues, type IncomingSetting } from "./account-settings.catalog.js";
import { ACCOUNT_SETTINGS_REPOSITORY, type AccountSettingsRepository } from "./account-settings.repository.js";

/**
 * Настройки аккаунта (docs/35-stage4-plan.md Р56, WP29): выбранное на одном
 * устройстве приходит на другое при следующем входе. Слияние — ключ за
 * ключом, побеждает выбранное позже (`account-settings.catalog.ts`).
 *
 * Старое устройство без настроек аккаунта сюда не пишет вовсе и потому
 * ничего не затирает; устройство, которое впервые пришло со своими прежними
 * значениями, шлёт их засевом — они займут только пустые ключи.
 */

const DB_TIMEOUT_MS = 3_000;

export interface AccountSettingsView {
  version: number;
  values: AccountSettingValues;
}

@Injectable()
export class AccountSettingsService {
  constructor(@Inject(ACCOUNT_SETTINGS_REPOSITORY) private readonly repository: AccountSettingsRepository) {}

  async get(account: AccountRef): Promise<AccountSettingsView> {
    const stored = await withTimeout(this.repository.get(account.accountId), DB_TIMEOUT_MS, "настройки аккаунта");
    return { version: stored?.version ?? ACCOUNT_SETTINGS_VERSION, values: readStored(stored?.values) };
  }

  /** Значение ключа для решения на сервере; `undefined` — игрок не выбирал, решает умолчание вызывающего. */
  async valueOf(accountId: string, key: string): Promise<AccountSettingValue | undefined> {
    const stored = await withTimeout(this.repository.get(accountId), DB_TIMEOUT_MS, "настройки аккаунта");
    return readStored(stored?.values)[key]?.value;
  }

  async merge(account: AccountRef, input: { version: number; values: Record<string, IncomingSetting> }, nowMs = Date.now()): Promise<AccountSettingsView & { ignored: string[] }> {
    let ignored: string[] = [];
    const saved = await withTimeout(
      this.repository.update(account.accountId, (current) => {
        const merged = mergeSettings(readStored(current?.values), input.values, nowMs);
        ignored = merged.ignored;
        // Версия — самая новая из виденных: откатывать её старым клиентом незачем.
        return { version: Math.max(current?.version ?? 0, input.version, ACCOUNT_SETTINGS_VERSION), values: merged.values };
      }),
      DB_TIMEOUT_MS,
      "настройки аккаунта",
    );
    return { ...saved, ignored };
  }
}
