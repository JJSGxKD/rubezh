import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import {
  PlaytestStatsBot,
  dailyReportDay,
  decideUpdate,
  type StatsBotApi,
  type StatsBotLocks,
} from "../src/modules/playtest/playtest-stats.bot.js";
import { PlaytestStatsService } from "../src/modules/playtest/playtest-stats.service.js";
import { TelegramApiError, TelegramBotApi, type TelegramUpdate } from "../src/modules/playtest/telegram-bot-api.js";
import { MemoryPlaytestStatsStore } from "./helpers/memory-playtest-stats.store.js";
import { MemoryPlaytestStore } from "./helpers/memory-playtest.store.js";

// Бот сводки плейтеста: кому отвечать, когда слать отчёт, как говорить с Bot API.

const TOKEN = "123456:SECRET-token";
const CHAT = "-1001234567890";
const NOW = Date.parse("2026-09-14T18:30:00Z"); // 21:30 по Москве

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    PLAYTEST_STATS_ENABLED: "true",
    PLAYTEST_STATS_CHAT_ID: CHAT,
    ADMIN_TELEGRAM_IDS: "111",
    ...env,
  });
}

function command(chat: { id: number; type: string }, fromId: number, text = "/stats", date = NOW / 1000): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, date, text, chat, from: { id: fromId, is_bot: false } } };
}

describe("кому бот отвечает", () => {
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

class MemoryLocks implements StatsBotLocks {
  poller: string | null = null;
  offset: number | null = null;
  readonly daily = new Set<string>();
  readonly commands = new Set<string>();
  async holdPoller(ownerId: string): Promise<boolean> {
    if (this.poller !== null && this.poller !== ownerId) return false;
    this.poller = ownerId;
    return true;
  }
  async releasePoller(ownerId: string): Promise<void> {
    if (this.poller === ownerId) this.poller = null;
  }
  async readOffset(): Promise<number | null> {
    return this.offset;
  }
  async saveOffset(offset: number): Promise<void> {
    this.offset = offset;
  }
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

function fakeApi(): StatsBotApi & { photos: { chatId: string; caption: string }[]; messages: string[]; updates: TelegramUpdate[]; failPhoto: Error | null } {
  const api = {
    photos: [] as { chatId: string; caption: string }[],
    messages: [] as string[],
    updates: [] as TelegramUpdate[],
    failPhoto: null as Error | null,
    async getUpdates() {
      const updates = api.updates.splice(0);
      return { updates, lastUpdateId: updates.at(-1)?.update_id ?? null };
    },
    async sendPhoto(chatId: string, _png: Buffer, caption: string) {
      if (api.failPhoto !== null) throw api.failPhoto;
      api.photos.push({ chatId, caption });
    },
    async sendMessage(_chatId: string, text: string) {
      api.messages.push(text);
    },
    async setMyCommands() {},
  };
  return api;
}

describe("бот сводки", () => {
  let locks: MemoryLocks;
  let api: ReturnType<typeof fakeApi>;
  let bot: PlaytestStatsBot;
  const cfg = config({ PLAYTEST_STATS_DAILY_AT: "21:00" });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    locks = new MemoryLocks();
    api = fakeApi();
    const stats = new PlaytestStatsService(new MemoryPlaytestStatsStore(), new MemoryPlaytestStore(), cfg);
    bot = new PlaytestStatsBot(cfg, stats, locks, api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("отвечает на команду картинкой, сдвигает смещение и не множит сводку на спам", async () => {
    api.updates = [
      { ...command({ id: Number(CHAT), type: "supergroup" }, 5), update_id: 41 },
      { ...command({ id: Number(CHAT), type: "supergroup" }, 6), update_id: 42 },
    ];
    await bot.pollOnce();
    expect(api.photos).toHaveLength(1);
    expect(api.photos[0]).toMatchObject({ chatId: CHAT });
    expect(api.photos[0]?.caption).toContain("Плейтест · 14 сентября, 21:30");
    expect(locks.offset).toBe(43);
  });

  it("не читает обновления, пока роль читателя у другого процесса", async () => {
    locks.poller = "another-process";
    api.updates = [command({ id: Number(CHAT), type: "supergroup" }, 5)];
    const waiting = bot.pollOnce();
    await bot.onModuleDestroy();
    await waiting;
    expect(api.photos).toHaveLength(0);
  });

  it("шлёт ежедневный отчёт один раз за сутки", async () => {
    await bot.tickDaily();
    await bot.tickDaily();
    expect(api.photos).toHaveLength(1);
    expect(locks.daily.has("2026-09-14")).toBe(true);
  });

  it("повторяет ежедневный отчёт после сетевой ошибки, но не после отказа Telegram", async () => {
    api.failPhoto = new TelegramApiError("sendPhoto", 0, "сеть недоступна", null);
    await bot.tickDaily();
    expect(locks.daily.size).toBe(0);

    api.failPhoto = new TelegramApiError("sendPhoto", 400, "Bad Request: chat not found", null);
    await bot.tickDaily();
    expect(locks.daily.size).toBe(1);
    // В чат о сбое ежедневного отчёта не пишем: писать, скорее всего, некуда.
    expect(api.messages).toHaveLength(0);
  });

  it("на сбой команды отвечает коротко, без подробностей", async () => {
    api.failPhoto = new TelegramApiError("sendPhoto", 0, "сеть недоступна", null);
    await bot.handleUpdate(command({ id: 111, type: "private" }, 111));
    expect(api.messages).toEqual(["Сводка не собралась, причина — в логе бэкенда"]);
  });
});

describe("клиент Bot API", () => {
  function recorder(reply: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply), { status });
    };
    return { calls, api: new TelegramBotApi(TOKEN, fetchImpl) };
  }

  it("пропускает нераспознанные обновления, но сдвигает смещение за них", async () => {
    const { calls, api } = recorder({
      ok: true,
      result: [
        { update_id: 7, message: { message_id: 1, date: 1, text: "/stats", chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false } } },
        { update_id: 8, message: { weird: true } },
      ],
    });
    const result = await api.getUpdates(7, 25);
    expect(result.updates.map((update) => update.update_id)).toEqual([7]);
    expect(result.lastUpdateId).toBe(8);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ offset: 7, timeout: 25, allowed_updates: ["message"] });
  });

  it("отправляет фото формой, а ошибку Telegram разбирает с retry_after", async () => {
    const ok = recorder({ ok: true, result: {} });
    await ok.api.sendPhoto(CHAT, Buffer.from("png"), "подпись");
    const form = ok.calls[0]?.init.body;
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("chat_id")).toBe(CHAT);

    const limited = recorder({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 12 } }, 429);
    await expect(limited.api.sendMessage(CHAT, "x")).rejects.toMatchObject({ errorCode: 429, retryAfterSec: 12 });
  });

  it("не выносит токен бота в текст ошибки сети", async () => {
    const api = new TelegramBotApi(TOKEN, async (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    });
    const error = await api.sendMessage(CHAT, "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
