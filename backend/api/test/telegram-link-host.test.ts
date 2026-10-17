import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { SETTING_KEY, SETTINGS, telegramLinkOriginOf, TELEGRAM_LINK_ORIGINS, type SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { linkOriginFor, appLinksFor } from "../src/platforms/platforms.module.js";
import { BotIdentity } from "../src/platforms/telegram/bot-identity.js";
import { SettingsLinkOrigin } from "../src/platforms/telegram/settings-link-origin.js";

// Домен ссылок Telegram — настройка панели (tasks/T-0090, Р100): t.me
// бывает недоступен, и переключить домен нужно без релиза.

const setting = SETTINGS.telegramLinkHost;

/** Читатель настроек с подменяемым значением ключа. */
function reader(initial: string): { source: Pick<SettingsReader, "get">; set(value: string): void } {
  let current = initial;
  return {
    source: { get: <T extends string | boolean | number>(_definition: SettingDefinition<T>): T => current as T },
    set: (value) => void (current = value),
  };
}

describe("запись каталога telegram.link-host", () => {
  it("ключ, вид, группа и умолчание", () => {
    expect(setting.key).toBe("telegram.link-host");
    expect(SETTING_KEY.test(setting.key)).toBe(true);
    expect(setting.kind).toBe("url");
    expect(setting.group).toBe("Ссылки Telegram");
    expect(setting.fallback).toBe("https://t.me");
    expect(setting.schema.safeParse(setting.fallback).success).toBe(true);
  });

  it("окружения у ключа нет: решение правится в панели", () => {
    expect(setting.fromEnv()).toBeNull();
  });

  it("домены из списка — равнозначные домены ссылок Telegram, telegram.org среди них нет", () => {
    expect(TELEGRAM_LINK_ORIGINS).toEqual(["https://t.me", "https://telegram.me", "https://telegram.dog"]);
  });
});

describe("схема значения", () => {
  it("принимает три домена, слэш на конце и пробелы вокруг", () => {
    for (const value of ["https://t.me", "https://telegram.me", "https://telegram.dog", "https://t.me/", "  https://telegram.dog  "]) {
      expect(setting.schema.safeParse(value).success, value).toBe(true);
    }
  });

  it("отклоняет всё остальное; сообщение называет допустимые домены", () => {
    const bad = ["", "t.me", "http://t.me", "https://telegram.org", "https://t.me/rubezh_bot", "https://t.me.example.com", "https://user@t.me", "https://t.me:8443", "https://t.me/?x=1", "https://t.me/#x"];
    for (const value of bad) {
      const result = setting.schema.safeParse(value);
      expect(result.success, value).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message, value).toContain("telegram.dog");
    }
  });
});

describe("telegramLinkOriginOf", () => {
  it("приводит к домену без слэша", () => {
    expect(telegramLinkOriginOf("https://telegram.me/")).toBe("https://telegram.me");
    expect(telegramLinkOriginOf("https://t.me")).toBe("https://t.me");
  });

  it("мусор и чужой домен — null", () => {
    expect(telegramLinkOriginOf("мусор")).toBeNull();
    expect(telegramLinkOriginOf("https://evil.example")).toBeNull();
    expect(telegramLinkOriginOf("https://t.me/bot")).toBeNull();
  });
});

describe("домен из настройки", () => {
  it("значение из списка отдаётся как есть, слэш на конце срезается", () => {
    expect(new SettingsLinkOrigin(reader("https://telegram.dog").source).origin()).toBe("https://telegram.dog");
    expect(new SettingsLinkOrigin(reader("https://telegram.me/").source).origin()).toBe("https://telegram.me");
  });

  it("значение, не прошедшее проверку, до ссылки не доходит — t.me", () => {
    expect(new SettingsLinkOrigin(reader("https://evil.example").source).origin()).toBe("https://t.me");
    expect(new SettingsLinkOrigin(reader("").source).origin()).toBe("https://t.me");
  });

  it("домен читается при каждой сборке: смена настройки видна сразу", () => {
    const settings = reader("https://t.me");
    const origin = new SettingsLinkOrigin(settings.source);
    expect(origin.origin()).toBe("https://t.me");
    settings.set("https://telegram.me");
    expect(origin.origin()).toBe("https://telegram.me");
  });

  it("провайдер модуля платформ читает настройку", () => {
    const settings = reader("https://telegram.dog");
    expect(linkOriginFor(settings.source as SettingsReader).origin()).toBe("https://telegram.dog");
  });
});

describe("ссылки сервера после переключения домена", () => {
  const config = loadAppConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_UPDATES: "polling" });

  it("launch, chat и miniAppLink идут с новым доменом, диплинки прежние", async () => {
    const settings = reader("https://t.me");
    const origin = new SettingsLinkOrigin(settings.source);
    const identity = new BotIdentity(config, { async getMe() { return { id: 1, username: "rubezh_bot" }; } }, origin);
    await identity.refresh();
    const links = appLinksFor(identity, origin);

    expect(links.launch("telegram", "c-1")).toBe("https://t.me/rubezh_bot?startapp=c-1");
    expect(links.chat("telegram", "panel-X")).toBe("https://t.me/rubezh_bot?start=panel-X");
    expect(identity.miniAppLink).toBe("https://t.me/rubezh_bot?startapp");

    settings.set("https://telegram.me");
    expect(links.launch("telegram", "c-1")).toBe("https://telegram.me/rubezh_bot?startapp=c-1");
    expect(links.chat("telegram", "panel-X")).toBe("https://telegram.me/rubezh_bot?start=panel-X");
    expect(identity.miniAppLink).toBe("https://telegram.me/rubezh_bot?startapp");

    expect(links.launchDeep("telegram", "c-1")).toBe("tg://resolve?domain=rubezh_bot&startapp=c-1");
    expect(links.chatDeep("telegram", "panel-X")).toBe("tg://resolve?domain=rubezh_bot&start=panel-X");
  });
});
