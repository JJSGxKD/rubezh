import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";

// Что дублировать в бота (docs/35-stage4-plan.md WP28, WP31, tasks/T-0128):
// выбор игрока хранится на устройстве. Ключ, появившийся в новой версии, у сохранённого
// раньше выбора отсутствует — он берёт умолчание, а прежний выбор не
// сбрасывается к умолчаниям как битый.

async function storeWith(saved: string | null) {
  vi.resetModules();
  const { initShell } = await import("../src/state/shell");
  const values: Record<string, string> = saved === null ? {} : { "bh.bot-notifications.v1": saved };
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: {
      get: (key) => values[key] ?? null,
      set: (key, value) => {
        values[key] = value;
      },
      remove: (key) => {
        delete values[key];
      },
    },
    analytics: () => undefined,
    build: { version: "test", contentHash: "abcd1234", platform: "web" },
  });
  const { useBotNotifications } = await import("../src/state/bot-notifications");
  return { store: useBotNotifications, values };
}

function choice(state: { friendRequest: boolean; friendGift: boolean; teamMessage: boolean; reminders: boolean }) {
  return { friendRequest: state.friendRequest, friendGift: state.friendGift, teamMessage: state.teamMessage, reminders: state.reminders };
}

describe("выбор дубля в бота на устройстве", () => {
  it("переключатели — заявки, подарки, сообщения команды и напоминания; о версиях бот не пишет", async () => {
    const { BOT_NOTIFY_KEYS } = await import("../src/state/bot-notifications");
    expect([...BOT_NOTIFY_KEYS]).toEqual(["friendRequest", "friendGift", "teamMessage", "reminders"]);
  });

  it("напоминания по умолчанию включены, ключ аккаунта — bot.reminders", async () => {
    const { BOT_NOTIFY_ACCOUNT_KEYS, BOT_NOTIFY_DEFAULTS, botNotifyKeyOf } = await import("../src/state/bot-notifications");
    expect(BOT_NOTIFY_DEFAULTS.reminders).toBe(true);
    expect(BOT_NOTIFY_ACCOUNT_KEYS.reminders).toBe("bot.reminders");
    expect(botNotifyKeyOf("bot.reminders")).toBe("reminders");
    const { store } = await storeWith(null);
    expect(store.getState().reminders).toBe(true);
  });

  it("выбор, сохранённый до напоминаний, не сбрасывается: новый ключ берёт умолчание", async () => {
    const { store } = await storeWith(JSON.stringify({ friendRequest: false, friendGift: true, teamMessage: false }));
    expect(choice(store.getState())).toEqual({ friendRequest: false, friendGift: true, teamMessage: false, reminders: true });
  });

  it("выключенные напоминания запоминаются на устройстве и применяются с другого устройства аккаунта", async () => {
    const { store, values } = await storeWith(null);
    expect(store.getState().toggle("reminders")).toBe(false);
    expect(JSON.parse(values["bh.bot-notifications.v1"] ?? "{}")).toMatchObject({ reminders: false });
    store.getState().applyAccount({ reminders: true });
    expect(store.getState().reminders).toBe(true);
  });

  it("название и описание настройки есть в словаре бота, как и у каждого переключателя", async () => {
    const { BOT_NOTIFY_KEYS } = await import("../src/state/bot-notifications");
    const entries = JSON.parse(readFileSync(fileURLToPath(new URL("../src/i18n/ru-bot.json", import.meta.url)), "utf8")) as Record<string, string>;
    for (const key of BOT_NOTIFY_KEYS) expect(entries[`settings.bot.${key}`], key).toBeTruthy();
    expect(entries["settings.bot.reminders"]).toBe("Напоминания");
    expect(entries["settings.bot.reminders.hint"]).toBe("Сообщение от бота не чаще раза в сутки: тебя обогнали в сезоне, сезон скоро закрывается или ждёт награда дня.");
  });

  it("выбор, сохранённый вместе с прежним полем updates, читается без сброса остальных", async () => {
    const { store } = await storeWith(JSON.stringify({ friendRequest: false, friendGift: true, teamMessage: false, updates: false }));
    expect(choice(store.getState())).toEqual({ friendRequest: false, friendGift: true, teamMessage: false, reminders: true });
  });

  it("при записи прежнее поле updates отбрасывается", async () => {
    const { store, values } = await storeWith(JSON.stringify({ friendRequest: false, friendGift: true, teamMessage: false, updates: false }));
    expect(store.getState().toggle("teamMessage")).toBe(true);
    expect(JSON.parse(values["bh.bot-notifications.v1"] ?? "{}")).toEqual({ friendRequest: false, friendGift: true, teamMessage: true, reminders: true });
  });

  it("битое значение — умолчания", async () => {
    const { store } = await storeWith(JSON.stringify({ friendRequest: "да" }));
    expect(choice(store.getState())).toEqual({ friendRequest: true, friendGift: false, teamMessage: true, reminders: true });
  });
});
