import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { BotRouter } from "../src/modules/bot/bot-router.js";
import {
  PlaytestStatsReporter,
  dailyReportDay,
  decideUpdate,
  type StatsReporterApi,
  type StatsReporterLocks,
} from "../src/modules/playtest/playtest-stats.reporter.js";
import { PlaytestStatsService } from "../src/modules/playtest/playtest-stats.service.js";
import { TelegramApiError, type TelegramUpdate } from "../src/modules/telegram/telegram-bot-api.js";
import { MemoryPlaytestStatsStore } from "./helpers/memory-playtest-stats.store.js";
import { MemoryPlaytestStore } from "./helpers/memory-playtest.store.js";

// Сводка плейтеста в Telegram: кому отвечать, когда слать отчёт.

const TOKEN = "123456:SECRET-token";
const CHAT = "-1001234567890";
const NOW = Date.parse("2026-09-14T18:30:00Z"); // 21:30 по Москве

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_BOT_UPDATES: "polling",
    PLAYTEST_STATS_ENABLED: "true",
    ADMIN_CHAT_ID: CHAT,
    ADMIN_TELEGRAM_IDS: "111",
    ...env,
  });
}

function command(chat: { id: number; type: string }, fromId: number, text = "/stats", date = NOW / 1000): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, date, text, chat, from: { id: fromId, is_bot: false } } };
}

describe("настройка сводки", () => {
  it("не стартует без чата и без чтения обновлений бота", () => {
    expect(() => config({ ADMIN_CHAT_ID: "" })).toThrow(/ADMIN_CHAT_ID/);
    expect(() => config({ TELEGRAM_BOT_UPDATES: "off" })).toThrow(/TELEGRAM_BOT_UPDATES/);
  });

  it("подсказывает новое имя переменной чата, а не молча её игнорирует", () => {
    expect(() => config({ PLAYTEST_STATS_CHAT_ID: CHAT })).toThrow(/переименована в ADMIN_CHAT_ID/);
  });
});

describe("кому сводка отвечает", () => {
  const cfg = config();

  it("отвечает любому участнику чата администраторов и адресной команде", () => {
    expect(decideUpdate(command({ id: Number(CHAT), type: "supergroup" }, 999), cfg, NOW)).toEqual({
      kind: "stats",
      chatId: CHAT,
      place: "admin_chat",
    });
    expect(decideUpdate(command({ id: Number(CHAT), type: "supergroup" }, 999, "/stats@rubezh_bot"), cfg, NOW).kind).toBe("stats");
  });

  it("в личке отвечает только администратору из списка", () => {
    expect(decideUpdate(command({ id: 111, type: "private" }, 111), cfg, NOW)).toMatchObject({ kind: "stats", place: "private" });
    expect(decideUpdate(command({ id: 222, type: "private" }, 222), cfg, NOW).kind).toBe("ignore");
  });

  it("молчит в чужой группе, даже если команду набрал администратор", () => {
    expect(decideUpdate(command({ id: -100999, type: "group" }, 111), cfg, NOW).kind).toBe("ignore");
  });

  it("не отвечает на старые команды из очереди, похожие команды и ботов", () => {
    expect(decideUpdate(command({ id: Number(CHAT), type: "group" }, 1, "/stats", NOW / 1000 - 3600), cfg, NOW).kind).toBe("ignore");
    expect(decideUpdate(command({ id: Number(CHAT), type: "group" }, 1, "/statsall"), cfg, NOW).kind).toBe("ignore");
    const fromBot = command({ id: Number(CHAT), type: "group" }, 1);
    if (fromBot.message?.from !== undefined) fromBot.message.from.is_bot = true;
    expect(decideUpdate(fromBot, cfg, NOW).kind).toBe("ignore");
  });
});

describe("ежедневный отчёт", () => {
  it("становится нужен с назначенной минуты в поясе команды", () => {
    const at = 21 * 60;
    expect(dailyReportDay(Date.parse("2026-09-14T17:59:00Z"), 180, at)).toBeNull();
    expect(dailyReportDay(Date.parse("2026-09-14T18:00:00Z"), 180, at)).toBe("2026-09-14");
    // После полуночи по Москве — уже новые сутки, и до 21:00 отчёт не нужен.
    expect(dailyReportDay(Date.parse("2026-09-14T21:30:00Z"), 180, at)).toBeNull();
    expect(dailyReportDay(NOW, 180, null)).toBeNull();
  });
});

class MemoryLocks implements StatsReporterLocks {
  readonly daily = new Set<string>();
  readonly commands = new Set<string>();
  async claimDaily(day: string): Promise<boolean> {
    if (this.daily.has(day)) return false;
    this.daily.add(day);
    return true;
  }
  async releaseDaily(day: string): Promise<void> {
    this.daily.delete(day);
  }
  async claimCommand(chatId: string): Promise<boolean> {
    if (this.commands.has(chatId)) return false;
    this.commands.add(chatId);
    return true;
  }
}

function fakeApi(): StatsReporterApi & { photos: { chatId: string; caption: string }[]; messages: string[]; failPhoto: Error | null } {
  const api = {
    photos: [] as { chatId: string; caption: string }[],
    messages: [] as string[],
    failPhoto: null as Error | null,
    async sendPhoto(chatId: string, _png: Buffer | string, caption: string) {
      if (api.failPhoto !== null) throw api.failPhoto;
      api.photos.push({ chatId, caption });
      return { messageId: api.photos.length, fileId: null };
    },
    async sendMessage(_chatId: string, text: string) {
      api.messages.push(text);
      return api.messages.length;
    },
    async setMyCommands() {},
  };
  return api;
}

describe("сводка в Telegram", () => {
  let locks: MemoryLocks;
  let api: ReturnType<typeof fakeApi>;
  let router: BotRouter;
  let reporter: PlaytestStatsReporter;
  const cfg = config({ PLAYTEST_STATS_DAILY_AT: "21:00" });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    locks = new MemoryLocks();
    api = fakeApi();
    router = new BotRouter();
    const stats = new PlaytestStatsService(new MemoryPlaytestStatsStore(), new MemoryPlaytestStore(), cfg);
    reporter = new PlaytestStatsReporter(cfg, stats, router, locks, api);
    reporter.onModuleInit();
  });

  afterEach(() => {
    reporter.onModuleDestroy();
    vi.useRealTimers();
  });

  it("отвечает на команду картинкой и не множит сводку на спам", async () => {
    await router.dispatch({ ...command({ id: Number(CHAT), type: "supergroup" }, 5), update_id: 41 });
    await router.dispatch({ ...command({ id: Number(CHAT), type: "supergroup" }, 6), update_id: 42 });
    expect(api.photos).toHaveLength(1);
    expect(api.photos[0]).toMatchObject({ chatId: CHAT });
    expect(api.photos[0]?.caption).toContain("Плейтест · 14 сентября, 21:30");
  });

  it("не забирает чужие обновления: /start уходит следующим обработчикам", async () => {
    expect(await reporter.handle(command({ id: 111, type: "private" }, 111, "/start"))).toBe(false);
  });

  it("шлёт ежедневный отчёт один раз за сутки", async () => {
    await reporter.tickDaily();
    await reporter.tickDaily();
    expect(api.photos).toHaveLength(1);
    expect(locks.daily.has("2026-09-14")).toBe(true);
  });

  it("повторяет ежедневный отчёт после сетевой ошибки, но не после отказа Telegram", async () => {
    api.failPhoto = new TelegramApiError("sendPhoto", 0, "сеть недоступна", null);
    await reporter.tickDaily();
    expect(locks.daily.size).toBe(0);

    api.failPhoto = new TelegramApiError("sendPhoto", 400, "Bad Request: chat not found", null);
    await reporter.tickDaily();
    expect(locks.daily.size).toBe(1);
    // В чат о сбое ежедневного отчёта не пишем: писать, скорее всего, некуда.
    expect(api.messages).toHaveLength(0);
  });

  it("на сбой команды отвечает коротко, без подробностей", async () => {
    api.failPhoto = new TelegramApiError("sendPhoto", 0, "сеть недоступна", null);
    await reporter.handle(command({ id: 111, type: "private" }, 111));
    expect(api.messages).toEqual(["Сводка не собралась, причина — в логе бэкенда"]);
  });
});
