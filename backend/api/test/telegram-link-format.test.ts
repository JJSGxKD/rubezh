import { describe, expect, it } from "vitest";
import { deepLink, webLink } from "../src/platforms/telegram/telegram-link-format.js";

// Форму ссылки Telegram знает один файл (tasks/T-0091): веб-ссылка зависит от
// домена, диплинк — нет.

describe("веб-ссылка на бота", () => {
  it("Mini App без параметра", () => {
    expect(webLink("https://t.me", "rubezh_bot", "app")).toBe("https://t.me/rubezh_bot?startapp");
  });

  it("Mini App с параметром", () => {
    expect(webLink("https://t.me", "rubezh_bot", "app", "c-Ab12")).toBe("https://t.me/rubezh_bot?startapp=c-Ab12");
  });

  it("чат с ботом: параметр start", () => {
    expect(webLink("https://t.me", "rubezh_bot", "chat", "panel-Ab_1-2")).toBe("https://t.me/rubezh_bot?start=panel-Ab_1-2");
  });

  it("параметр кодируется", () => {
    expect(webLink("https://t.me", "rubezh_bot", "app", "a b&c")).toBe("https://t.me/rubezh_bot?startapp=a%20b%26c");
  });

  it("домен берётся из аргумента", () => {
    expect(webLink("https://telegram.me", "rubezh_bot", "app")).toMatch(/^https:\/\/telegram\.me\/rubezh_bot/);
  });
});

describe("диплинк", () => {
  it("Mini App и чат", () => {
    expect(deepLink("rubezh_bot", "app", "c-1")).toBe("tg://resolve?domain=rubezh_bot&startapp=c-1");
    expect(deepLink("rubezh_bot", "chat", "c-1")).toBe("tg://resolve?domain=rubezh_bot&start=c-1");
  });
});
