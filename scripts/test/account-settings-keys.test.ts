import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNT_SETTINGS, ACCOUNT_SETTINGS_VERSION as SERVER_VERSION, ACCOUNT_SETTING_KEYS as SERVER_KEYS } from "../../backend/api/src/modules/account-settings/account-settings.catalog.js";
import { BOT_NOTIFY } from "../../backend/api/src/modules/notifications-bot/bot-notify-rules.js";

// Настройки аккаунта (docs/35-stage4-plan.md WP29): ключи живут и на сервере,
// и в клиенте — собранный бэкенд пакеты клиента не импортирует. Разойдись они,
// клиент слал бы ключ, который сервер молча пропускает, и настройка не
// доезжала бы до другого устройства — заметить это можно только руками.
// Клиентские модули читаются как текст: их импорт потянул бы сторы оболочки.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const client = readFileSync(join(repoRoot, "packages/app-shell/src/state/account-settings.ts"), "utf8");
const hints = readFileSync(join(repoRoot, "packages/app-shell/src/state/hints.ts"), "utf8");
const botNotifications = readFileSync(join(repoRoot, "packages/app-shell/src/state/bot-notifications.ts"), "utf8");

function quotedList(source: string, name: string): string[] {
  const list = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

const clientKeys = (): string[] => quotedList(client, "ACCOUNT_SETTING_KEYS");

describe("ключи настроек аккаунта", () => {
  it("клиент и сервер знают одни и те же ключи", () => {
    expect(clientKeys().length).toBeGreaterThan(0);
    expect([...clientKeys()].sort()).toEqual([...SERVER_KEYS].sort());
  });

  it("все подсказки клиента проходят серверную схему усвоенного — иначе список молча не сохранится", () => {
    const order = quotedList(hints, "HINT_ORDER");
    expect(order.length).toBeGreaterThan(0);
    expect(ACCOUNT_SETTINGS["hints.seen"]?.schema.safeParse(order).success).toBe(true);
  });

  it("что дублировать в бота: ключи и умолчания клиента — те же, что у сервера", () => {
    // Разойдись умолчание — переключатель показывал бы «включено», а сервер
    // молчал бы, пока игрок не щёлкнет им дважды.
    const defaults = /export const BOT_NOTIFY_DEFAULTS = \{([^}]*)\}/.exec(botNotifications)?.[1] ?? "";
    const accountKeys = /export const BOT_NOTIFY_ACCOUNT_KEYS = \{([^}]*)\}/.exec(botNotifications)?.[1] ?? "";
    const rules = Object.values(BOT_NOTIFY);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const clientKey = new RegExp(`(\\w+): "${rule.setting.replace(".", "\\.")}"`).exec(accountKeys)?.[1];
      expect(clientKey, rule.setting).toBeDefined();
      expect(new RegExp(`${String(clientKey)}: (true|false)`).exec(defaults)?.[1], rule.setting).toBe(String(rule.byDefault));
      expect(SERVER_KEYS).toContain(rule.setting);
    }
  });

  it("версия набора ключей одна", () => {
    expect(/export const ACCOUNT_SETTINGS_VERSION = (\d+);/.exec(client)?.[1]).toBe(String(SERVER_VERSION));
  });
});
