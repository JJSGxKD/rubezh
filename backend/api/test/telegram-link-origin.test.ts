import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotIdentity } from "../src/platforms/telegram/bot-identity.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import type { LinkOrigin } from "../src/platforms/telegram/telegram-link-format.js";

// Домен ссылок спрашивается в момент сборки (tasks/T-0091): настройка из
// панели начнёт действовать без перезапуска.

const config = loadAppConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_UPDATES: "polling" });
const api = { async getMe() { return { id: 1, username: "rubezh_bot" }; } };

function origin(initial: string): { source: LinkOrigin; set(value: string): void } {
  let current = initial;
  return { source: { origin: () => current }, set: (value) => (current = value) };
}

describe("ссылка на Mini App у бота", () => {
  it("смена домена видна при следующем чтении, без пересоздания", async () => {
    const domain = origin("https://t.me");
    const identity = new BotIdentity(config, api, domain.source);
    await identity.refresh();
    expect(identity.miniAppLink).toBe("https://t.me/rubezh_bot?startapp");
    domain.set("https://telegram.me");
    expect(identity.miniAppLink).toBe("https://telegram.me/rubezh_bot?startapp");
  });

  it("без источника домена — t.me; до знакомства с ботом ссылки нет", async () => {
    const identity = new BotIdentity(config, api);
    expect(identity.miniAppLink).toBeNull();
    await identity.refresh();
    expect(identity.miniAppLink).toBe("https://t.me/rubezh_bot?startapp");
  });
});

describe("ссылки через бота", () => {
  it("чат берёт домен из источника, диплинк от него не зависит", () => {
    const domain = origin("https://telegram.me");
    const links = new TelegramAppLinks({ miniAppLink: null, username: "rubezh_bot" }, domain.source);
    expect(links.chat("panel-X")).toBe("https://telegram.me/rubezh_bot?start=panel-X");
    expect(links.chatDeep("panel-X")).toBe("tg://resolve?domain=rubezh_bot&start=panel-X");
    domain.set("https://t.me");
    expect(links.chat("panel-X")).toBe("https://t.me/rubezh_bot?start=panel-X");
    expect(links.chatDeep("panel-X")).toBe("tg://resolve?domain=rubezh_bot&start=panel-X");
  });

  it("имя бота неизвестно — ссылок нет", () => {
    const links = new TelegramAppLinks({ miniAppLink: null, username: null });
    expect(links.chat("panel-X")).toBeNull();
    expect(links.chatDeep("panel-X")).toBeNull();
    expect(links.launchDeep("c-1")).toBeNull();
  });
});
