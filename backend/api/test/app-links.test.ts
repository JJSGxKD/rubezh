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
});
