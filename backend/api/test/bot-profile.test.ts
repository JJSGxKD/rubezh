import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotProfile, type BotProfileState, type ProfileBotApi } from "../src/platforms/telegram/bot-profile.js";
import { BOT_PROFILE_TEXTS } from "../src/platforms/telegram/bot-profile-texts.js";

// Профиль бота из кода (src/platforms/telegram/bot-profile.ts).

function setup(env: Record<string, string> = {}) {
  const config = loadAppConfig({ TELEGRAM_BOT_TOKEN: "1:TEST", TELEGRAM_BOT_UPDATES: "polling", PUBLIC_WEB_URL: "https://tg.example", ...env });
  const calls: string[] = [];
  let failOn: string | null = null;
  const record = (name: string) => {
    if (name === failOn) throw new Error(`${name} упал`);
    calls.push(name);
  };
  const api: ProfileBotApi = {
    async setMyName(_name, language) { record(`name:${language ?? "default"}`); },
    async setMyDescription(_text, language) { record(`description:${language ?? "default"}`); },
    async setMyShortDescription(_text, language) { record(`short:${language ?? "default"}`); },
    async setMenuWebApp(text, url, chatId) { record(`menu:${text}:${url}:${chatId ?? "all"}`); },
    async setMyProfilePhoto(png) { record(`photo:${png.length > 1000 ? "png" : "empty"}`); },
  };
  let stored: string | null = null;
  const state: BotProfileState = {
    async applied() { return stored; },
    async remember(fingerprint) { stored = fingerprint; },
  };
  return { profile: new BotProfile(config, api, state), calls, failAt: (name: string | null) => { failOn = name; } };
}

describe("профиль бота", () => {
  it("применяет имя и описания по умолчанию и на каждом языке, кнопку меню и фото", async () => {
    const bot = setup();
    expect(await bot.profile.publish()).toBe("applied");
    for (const language of ["default", "ru", "en"]) {
      expect(bot.calls).toEqual(expect.arrayContaining([`name:${language}`, `description:${language}`, `short:${language}`]));
    }
    expect(bot.calls).toContain("menu:Играть:https://tg.example:all");
    expect(bot.calls).toContain("photo:png");
  });

  it("не трогает Telegram, если профиль не менялся", async () => {
    const bot = setup();
    await bot.profile.publish();
    bot.calls.length = 0;
    expect(await bot.profile.publish()).toBe("unchanged");
    expect(bot.calls).toEqual([]);
  });

  it("оборвался посередине — следующий старт применит профиль заново", async () => {
    const bot = setup();
    bot.failAt("photo:png");
    await expect(bot.profile.publish()).rejects.toThrow();
    bot.failAt(null);
    expect(await bot.profile.publish()).toBe("applied");
  });

  it("без адреса Mini App кнопку меню не ставит", async () => {
    const bot = setup({ PUBLIC_WEB_URL: "" });
    await bot.profile.publish();
    expect(bot.calls.some((call) => call.startsWith("menu:"))).toBe(false);
  });

  it("тексты — в пределах Telegram: имя до 64, короткое до 120, описание до 512", () => {
    for (const texts of Object.values(BOT_PROFILE_TEXTS)) {
      expect(texts.name.length).toBeLessThanOrEqual(64);
      expect(texts.shortDescription.length).toBeLessThanOrEqual(120);
      expect(texts.description.length).toBeLessThanOrEqual(512);
    }
  });
});
