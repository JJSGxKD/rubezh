import { describe, expect, it } from "vitest";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";

/** Ссылки площадки через бота: запуск приложения — `startapp`, чат с ботом — `start`; без бота — нет ссылки. */
describe("ссылки площадки", () => {
  it("Telegram: t.me/<бот>?startapp=<параметр>", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    expect(links.launch("telegram", "c-Ab12Cd34Ef")).toBe("https://t.me/rubezh_bot?startapp=c-Ab12Cd34Ef");
  });

  it("Telegram: чат с ботом — t.me/<бот>?start=<параметр>", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    expect(links.chat("telegram", "panel-Ab12")).toBe("https://t.me/rubezh_bot?start=panel-Ab12");
  });

  it("бот ещё не представился или площадка без приложения — ссылки нет", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: null, username: null })]);
    expect(links.launch("telegram", "c-x")).toBeNull();
    expect(links.chat("telegram", "panel-x")).toBeNull();
    expect(links.launch("vk", "c-x")).toBeNull();
    expect(links.chat("vk", "panel-x")).toBeNull();
  });

  it("Telegram: диплинк в установленный клиент — tg://resolve, без страницы t.me", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    expect(links.chatDeep("telegram", "panel-abc")).toBe("tg://resolve?domain=rubezh_bot&start=panel-abc");
    expect(links.launchDeep("telegram", "c-1")).toBe("tg://resolve?domain=rubezh_bot&startapp=c-1");
    // Параметр кодируется, как у обычных ссылок: лишний `&` не должен стать вторым параметром.
    expect(links.chatDeep("telegram", "a&b=c")).toBe("tg://resolve?domain=rubezh_bot&start=a%26b%3Dc");
  });

  it("диплинка нет: бот не представился или у площадки нет такого метода", () => {
    const withoutBot = new AppLinks([new TelegramAppLinks({ miniAppLink: null, username: null })]);
    expect(withoutBot.chatDeep("telegram", "panel-x")).toBeNull();
    expect(withoutBot.launchDeep("telegram", "c-x")).toBeNull();
    // Площадка без диплинков — отдаёт обычные ссылки, а `null` значит «веди по обычной».
    const plain = new AppLinks([{ platform: "vk", launch: () => "https://vk.com/app1?x=1", chat: () => "https://vk.me/bot" }]);
    expect(plain.chatDeep("vk", "panel-x")).toBeNull();
    expect(plain.launchDeep("vk", "c-x")).toBeNull();
    expect(plain.chat("vk", "panel-x")).toBe("https://vk.me/bot");
    expect(plain.chatDeep("max", "panel-x")).toBeNull();
  });
});
