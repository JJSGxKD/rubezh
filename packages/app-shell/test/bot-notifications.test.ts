import { describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";

// Что дублировать в бота (docs/35-stage4-plan.md WP28, WP31): выбор игрока
// хранится на устройстве. Ключ, появившийся в новой версии, у сохранённого
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

function choice(state: { friendRequest: boolean; friendGift: boolean; teamMessage: boolean; updates: boolean }) {
  return { friendRequest: state.friendRequest, friendGift: state.friendGift, teamMessage: state.teamMessage, updates: state.updates };
}

describe("выбор дубля в бота на устройстве", () => {
  it("выбор, сохранённый до «новых версий», не сбрасывается, а новый ключ берёт умолчание", async () => {
    const { store } = await storeWith(JSON.stringify({ friendRequest: false, friendGift: true, teamMessage: false }));
    expect(choice(store.getState())).toEqual({ friendRequest: false, friendGift: true, teamMessage: false, updates: true });
  });

  it("переключатель «новые версии» сохраняется вместе с остальными", async () => {
    const { store, values } = await storeWith(null);
    expect(store.getState().toggle("updates")).toBe(false);
    expect(JSON.parse(values["bh.bot-notifications.v1"] ?? "{}")).toEqual({ friendRequest: true, friendGift: false, teamMessage: true, updates: false });
  });

  it("битое значение — умолчания", async () => {
    const { store } = await storeWith(JSON.stringify({ friendRequest: "да" }));
    expect(choice(store.getState())).toEqual({ friendRequest: true, friendGift: false, teamMessage: true, updates: true });
  });
});
