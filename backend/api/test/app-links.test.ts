import { describe, expect, it } from "vitest";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";

/** Ссылки площадки через бота: запуск приложения — `startapp`, чат с ботом — `start`; без бота — нет ссылки. */
describe("ссылки площадки", () => {
  it("Telegram: t.me/<бот>?startapp=<параметр>", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    expect(links.launch("telegram", "c-Ab12Cd34Ef")).toBe("https://t.me/rubezh_bot?startapp=c-Ab12Cd34Ef");
  });

  it("Telegram: хвост меток дописывается к параметру без кодирования, сам параметр кодируется (T-0181)", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    expect(links.launch("telegram", "l-AbC123xyz9", "_campaign-{campaign_id}")).toBe("https://t.me/rubezh_bot?startapp=l-AbC123xyz9_campaign-{campaign_id}");
    expect(links.launch("telegram", "l-AbC123xyz9", "_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}")).toBe(
      "https://t.me/rubezh_bot?startapp=l-AbC123xyz9_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}",
    );
    // Параметр по-прежнему кодируется, хвост — нет.
    expect(links.launch("telegram", "a&b", "_x-{y}")).toBe("https://t.me/rubezh_bot?startapp=a%26b_x-{y}");
    // Без хвоста и с пустым хвостом — как раньше.
    expect(links.launch("telegram", "l-AbC123xyz9")).toBe("https://t.me/rubezh_bot?startapp=l-AbC123xyz9");
    expect(links.launch("telegram", "l-AbC123xyz9", "")).toBe("https://t.me/rubezh_bot?startapp=l-AbC123xyz9");
  });

  it("Telegram: хвост не из A-Za-z0-9_-{} — ссылки нет, сломанную не отдаём", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]);
    for (const tail of ["_a b", "_a&b=c", "_a?b", "_a#b", "_кампания", "_a%7Bb", "_a=b", "_a/b", "_a.b", "_a\\b", "_a\nb"]) {
      expect(links.launch("telegram", "l-AbC123xyz9", tail), tail).toBeNull();
    }
  });

  it("Telegram: бот не представился — ссылки нет и с хвостом", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: null, username: null })]);
    expect(links.launch("telegram", "l-AbC123xyz9", "_campaign-{campaign_id}")).toBeNull();
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
