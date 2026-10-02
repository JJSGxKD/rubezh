import type { SettingValue } from "../../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../../src/modules/settings/settings.service.js";

/**
 * Настройки панели в памяти: заданный ключ — как строка в базе, остальное —
 * умолчание каталога. `set` — правка из панели посреди теста.
 */
export function panelSettings(initial: Readonly<Record<string, SettingValue>> = {}): SettingsReader & { set(key: string, value: SettingValue): void } {
  const values = new Map<string, SettingValue>(Object.entries(initial));
  return {
    get: (setting) => (values.has(setting.key) ? setting.schema.parse(values.get(setting.key)) : setting.fallback),
    onChange: () => undefined,
    set: (key, value) => void values.set(key, value),
  };
}
