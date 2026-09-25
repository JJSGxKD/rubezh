import { describe, expect, it } from "vitest";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";

/** Ссылка запуска приложения площадки — параметр в `startapp`, без бота — нет ссылки. */
describe("ссылка запуска приложения", () => {
  it("Telegram: t.me/<бот>?startapp=<параметр>", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp" })]);
    expect(links.launch("telegram", "c-Ab12Cd34Ef")).toBe("https://t.me/rubezh_bot?startapp=c-Ab12Cd34Ef");
  });

  it("бот ещё не представился или площадка без приложения — ссылки нет", () => {
    const links = new AppLinks([new TelegramAppLinks({ miniAppLink: null })]);
    expect(links.launch("telegram", "c-x")).toBeNull();
    expect(links.launch("vk", "c-x")).toBeNull();
  });
});
