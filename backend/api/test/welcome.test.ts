import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotRouter } from "../src/modules/bot/bot-router.js";
import { chatTargetOf } from "../src/modules/telegram/chat-target.js";
import { TelegramApiError, type SendOptions, type TelegramUpdate } from "../src/modules/telegram/telegram-bot-api.js";
import {
  displayName,
  renderWelcomePng,
  renderWelcomeSvg,
  welcomeCacheKey,
  type WelcomeCard,
  type WelcomeProgress,
} from "../src/modules/welcome/welcome-card.js";
import { languageOf } from "../src/modules/welcome/welcome-texts.js";
import {
  StartCommand,
  WelcomeProgressRegistry,
  type WelcomeBotApi,
  type WelcomeCardCache,
} from "../src/modules/welcome/welcome.command.js";

// Приветствие по /start (docs/28-diagnostics.md §6.1.2).

const TOKEN = "123456:TEST-welcome";
const VETERAN: WelcomeProgress = { best: { difficulty: "normal", survivalSec: 462.7, rank: 3, total: 41 }, runs: 12 };

function start(fromId: number, patch: { language?: string; name?: string; chat?: string; text?: string } = {}): TelegramUpdate {
  return {
    update_id: fromId,
    message: {
      message_id: 1,
      date: 1,
      text: patch.text ?? "/start",
      chat: { id: fromId, type: patch.chat ?? "private" },
      from: { id: fromId, is_bot: false, first_name: patch.name ?? "Анна", ...(patch.language === undefined ? {} : { language_code: patch.language }) },
    },
  };
}

describe("карточка приветствия", () => {
  it("говорит по-русски с русским, украинским и молчащим клиентом, иначе — по-английски", () => {
    expect(languageOf("ru")).toBe("ru");
    expect(languageOf("uk")).toBe("ru");
    expect(languageOf(undefined)).toBe("ru");
    expect(languageOf("en-US")).toBe("en");
    expect(languageOf("de")).toBe("en");
  });

  it("убирает из имени эмодзи и разметку, длинное обрезает, пустое заменяет", () => {
    expect(displayName("Анна 🎮✨", "ru")).toBe("Анна");
    expect(displayName("<b>Zoe</b>", "en")).toBe("bZoeb");
    expect(displayName("🔥🔥", "ru")).toBe("боец");
    expect(displayName("Alexandra-Marie Longname", "en")).toBe("Alexandra-Marie L…");
  });

  it("одинаковое содержимое — один ключ кэша, и имени в нём в открытом виде нет", () => {
    const card: WelcomeCard = { language: "ru", name: "Анна", progress: VETERAN };
    expect(welcomeCacheKey(card)).toBe(welcomeCacheKey({ ...card, progress: { ...VETERAN } }));
    // Доли секунды не видны на картинке и не должны плодить копии.
    expect(welcomeCacheKey(card)).toBe(welcomeCacheKey({ ...card, progress: { ...VETERAN, best: { ...VETERAN.best!, survivalSec: 462.9 } } }));
    expect(welcomeCacheKey(card)).not.toBe(welcomeCacheKey({ ...card, language: "en" }));
    expect(welcomeCacheKey(card)).not.toBe(welcomeCacheKey({ ...card, progress: { ...VETERAN, runs: 13 } }));
    expect(welcomeCacheKey(card)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("рисует рекорд и место, а новичку — суть игры", () => {
    const veteran = renderWelcomeSvg({ language: "ru", name: "Анна", progress: VETERAN });
    expect(veteran).toContain("7:43");
    expect(veteran).toContain("#3 из 41");
    expect(veteran).toContain("12 забегов");
    const newcomer = renderWelcomeSvg({ language: "en", name: "Zoe", progress: { best: null, runs: 0 } });
    expect(newcomer).toContain("Hi, Zoe!");
    expect(newcomer).not.toContain("best ·");
    expect(renderWelcomePng({ language: "ru", name: "Анна", progress: VETERAN }).subarray(1, 4).toString()).toBe("PNG");
  });
});

class MemoryCache implements WelcomeCardCache {
  readonly files = new Map<string, string>();
  readonly starts = new Set<string>();
  async get(key: string): Promise<string | null> {
    return this.files.get(key) ?? null;
  }
  async set(key: string, fileId: string): Promise<void> {
    this.files.set(key, fileId);
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  async claimStart(chatId: string): Promise<boolean> {
    if (this.starts.has(chatId)) return false;
    this.starts.add(chatId);
    return true;
  }
}

interface SentPhotoCall {
  chatId: string;
  photo: "bytes" | string;
  caption: string;
  options: SendOptions;
}

function setup(env: Record<string, string> = {}, progress: () => Promise<WelcomeProgress | null> = async () => VETERAN) {
  const config = loadAppConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_UPDATES: "polling", PUBLIC_WEB_URL: "https://game.example", ...env });
  const cache = new MemoryCache();
  const calls: SentPhotoCall[] = [];
  let renders = 0;
  let rejectFileId = false;
  const api: WelcomeBotApi = {
    async sendPhoto(chat, photo, caption, _signal, options = {}) {
      if (typeof photo === "string" && rejectFileId) throw new TelegramApiError("sendPhoto", 400, "Bad Request: wrong file identifier", null);
      calls.push({ chatId: chatTargetOf(chat).chatId, photo: typeof photo === "string" ? photo : "bytes", caption, options });
      return { messageId: calls.length, fileId: `file-${calls.length}` };
    },
    async setMyCommands() {},
  };
  const registry = new WelcomeProgressRegistry();
  registry.source = { progress };
  const router = new BotRouter();
  const command = new StartCommand(config, router, registry, cache, api, (card) => {
    renders++;
    return Buffer.from(`png:${card.name}`);
  });
  command.onModuleInit();
  return {
    router,
    cache,
    calls,
    renders: () => renders,
    rejectCachedFiles: () => {
      rejectFileId = true;
    },
  };
}

describe("/start в боте", () => {
  it("рисует карточку один раз: повторный /start того же игрока уходит по file_id", async () => {
    const bot = setup();
    await bot.router.dispatch(start(7));
    bot.cache.starts.clear(); // окно двойного нажатия прошло
    await bot.router.dispatch(start(7));

    expect(bot.renders()).toBe(1);
    expect(bot.calls.map((call) => call.photo)).toEqual(["bytes", "file-1"]);
    expect(bot.calls[0]?.options.keyboard).toEqual([[{ text: "▶ Играть", web_app: { url: "https://game.example" } }]]);
    expect(bot.calls[0]?.caption).toContain("Анна");
  });

  it("одинаковые карточки разных игроков тоже не рисуются заново", async () => {
    const bot = setup();
    await bot.router.dispatch(start(7));
    await bot.router.dispatch(start(8));
    expect(bot.renders()).toBe(1);
    expect(bot.calls[1]?.photo).toBe("file-1");
  });

  it("протухший file_id — рисует и загружает заново", async () => {
    const bot = setup();
    await bot.router.dispatch(start(7));
    bot.cache.starts.clear();
    bot.rejectCachedFiles();
    await bot.router.dispatch(start(7));
    expect(bot.renders()).toBe(2);
    expect(bot.cache.files.size).toBe(1);
  });

  it("двойное нажатие даёт одну карточку, группа и чужие команды — ни одной", async () => {
    const bot = setup();
    await bot.router.dispatch(start(7));
    await bot.router.dispatch(start(7));
    await bot.router.dispatch(start(9, { chat: "supergroup" }));
    await bot.router.dispatch(start(10, { text: "/stats" }));
    expect(bot.calls).toHaveLength(1);
  });

  it("администратору с включённой выгрузкой — вторая кнопка, остальным — нет", async () => {
    const bot = setup({ ADMIN_TELEGRAM_IDS: "7", DATA_EXPORT_BOT_ENABLED: "true", EXPORT_PSEUDONYM_KEY: "a".repeat(64), DATABASE_URL: "postgresql://unused" });
    await bot.router.dispatch(start(7));
    await bot.router.dispatch(start(8));
    expect(bot.calls[0]?.options.keyboard?.[1]).toEqual([{ text: "📦 Выгрузка данных", callback_data: "export:menu" }]);
    expect(bot.calls[1]?.options.keyboard).toHaveLength(1);
  });

  it("без прогресса и без HTTPS-адреса игры — карточка новичка без кнопки", async () => {
    const bot = setup({ PUBLIC_WEB_URL: "http://localhost:5173" }, async () => Promise.reject(new Error("redis down")));
    await bot.router.dispatch(start(7, { language: "en", name: "Zoe" }));
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]?.options.keyboard).toBeUndefined();
    expect(bot.calls[0]?.caption).toContain("welcome");
  });
});
