import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotFallbackReply, FALLBACK_TEXTS } from "../src/platforms/telegram/bot-fallback.js";
import { BotIdentity } from "../src/platforms/telegram/bot-identity.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { chatTargetOf, type ChatRef } from "../src/platforms/ports/chat-target.js";
import type { InlineButton, SendOptions, TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";

// Ответ бота на обычное сообщение (tasks/T-0020): подсказка и кнопка «Играть»,
// не чаще раза в 10 минут одному человеку, только в личке и только на текст.

const WEB_APP = "https://game.example";

interface Sent {
  chatId: string;
  text: string;
  keyboard: InlineButton[][] | undefined;
}

function setup(options: { env?: Record<string, string>; botUsername?: string | null; redisFails?: boolean } = {}) {
  const config = loadAppConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "1:TEST",
    TELEGRAM_BOT_UPDATES: "polling",
    PUBLIC_WEB_URL: WEB_APP,
    ...options.env,
  });
  const sent: Sent[] = [];
  const api = {
    async sendMessage(chat: ChatRef, text: string, _signal?: AbortSignal, sendOptions: SendOptions = {}) {
      sent.push({ chatId: chatTargetOf(chat).chatId, text, keyboard: sendOptions.keyboard });
      return sent.length;
    },
  };
  const keys = new Set<string>();
  const redis = {
    async set(key: string, _value: string, _ex: "EX", _ttl: number, _nx: "NX") {
      if (options.redisFails === true) throw new Error("Redis недоступен");
      if (keys.has(key)) return null;
      keys.add(key);
      return "OK";
    },
  } as unknown as Redis;
  const botUsername = options.botUsername === undefined ? "rubezh_test_bot" : options.botUsername;
  const identity = new BotIdentity(config, { async getMe() { return { id: 1, username: botUsername ?? "" }; } });
  const router = new BotRouter();
  const setFallback = vi.spyOn(router, "setFallback");
  const reply = new BotFallbackReply(config, router, identity, api, redis);
  return { reply, router, setFallback, sent, keys, ready: botUsername === null ? Promise.resolve() : identity.refresh() };
}

function message(fromId: number, patch: { text?: string | null; chat?: string; language?: string; isBot?: boolean; extra?: Record<string, unknown> } = {}): TelegramUpdate {
  const text = patch.text === undefined ? "привет" : patch.text;
  return {
    update_id: fromId,
    message: {
      message_id: 1,
      date: 1,
      ...(text === null ? {} : { text }),
      chat: { id: fromId, type: patch.chat ?? "private" },
      from: { id: fromId, is_bot: patch.isBot ?? false, first_name: "Анна", ...(patch.language === undefined ? {} : { language_code: patch.language }) },
      ...patch.extra,
    },
  } as TelegramUpdate;
}

describe("ответ на обычное сообщение", () => {
  it("в личке отвечает подсказкой и кнопкой «Играть»", async () => {
    const bot = setup();
    await bot.ready;

    expect(await bot.reply.handle(message(1, { language: "ru" }))).toBe(true);

    expect(bot.sent).toEqual([{ chatId: "1", text: FALLBACK_TEXTS.ru, keyboard: [[{ text: "▶ Играть", web_app: { url: WEB_APP } }]] }]);
  });

  it("тот же игрок второй раз в окне — тишина, другой игрок — ответ", async () => {
    const bot = setup();
    await bot.reply.handle(message(1));
    await bot.reply.handle(message(1, { text: "а как играть?" }));
    expect(bot.sent).toHaveLength(1);

    await bot.reply.handle(message(2));
    expect(bot.sent).toHaveLength(2);
  });

  it("окно — десять минут на игрока", async () => {
    const bot = setup();
    await bot.reply.handle(message(7));
    expect([...bot.keys]).toEqual(["bot:fallback:7"]);
  });

  it("английскому клиенту — английский текст и «▶ Play»", async () => {
    const bot = setup();
    await bot.reply.handle(message(3, { language: "en" }));
    expect(bot.sent[0]?.text).toBe(FALLBACK_TEXTS.en);
    expect(bot.sent[0]?.keyboard).toEqual([[{ text: "▶ Play", web_app: { url: WEB_APP } }]]);
  });

  it("в группе молчит", async () => {
    const bot = setup();
    await bot.reply.handle(message(4, { chat: "group" }));
    await bot.reply.handle(message(5, { chat: "supergroup" }));
    expect(bot.sent).toEqual([]);
  });

  it("на сообщения без текста (оплата, стикер, фото) молчит", async () => {
    const bot = setup();
    const payment = { currency: "XTR", total_amount: 1, invoice_payload: "x", telegram_payment_charge_id: "c" };
    await bot.reply.handle(message(6, { text: null, extra: { successful_payment: payment } }));
    await bot.reply.handle(message(8, { text: null }));
    expect(bot.sent).toEqual([]);
    expect(bot.keys.size).toBe(0);
  });

  it("другим ботам не отвечает", async () => {
    const bot = setup();
    await bot.reply.handle(message(9, { isBot: true }));
    expect(bot.sent).toEqual([]);
  });

  it("обновление без сообщения — не его дело, но обработчик не падает", async () => {
    const bot = setup();
    await expect(bot.reply.handle({ update_id: 1 })).resolves.toBe(true);
    expect(bot.sent).toEqual([]);
  });

  it("Redis недоступен — не отвечает и не падает", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const bot = setup({ redisFails: true });
      await expect(bot.reply.handle(message(10))).resolves.toBe(true);
      expect(bot.sent).toEqual([]);
      expect(warn.mock.calls.some(([line]) => String(line).includes("fallback_window_unavailable"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("без HTTPS-адреса и имени бота — сообщение без клавиатуры", async () => {
    const bot = setup({ env: { PUBLIC_WEB_URL: "http://localhost:5173" }, botUsername: null });
    await bot.reply.handle(message(11));
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.keyboard).toBeUndefined();
  });

  it("без HTTPS-адреса, но с именем бота — кнопка-ссылка", async () => {
    const bot = setup({ env: { PUBLIC_WEB_URL: "http://localhost:5173" } });
    await bot.ready;
    await bot.reply.handle(message(12));
    expect(bot.sent[0]?.keyboard).toEqual([[{ text: "▶ Играть", url: "https://t.me/rubezh_test_bot?startapp" }]]);
  });

  it("становится обработчиком по умолчанию, пока чтение обновлений включено", () => {
    const on = setup();
    on.reply.onModuleInit();
    expect(on.setFallback).toHaveBeenCalledWith(on.reply);

    const off = setup({ env: { TELEGRAM_BOT_UPDATES: "off" } });
    off.reply.onModuleInit();
    expect(off.setFallback).not.toHaveBeenCalled();
  });

  it("тексты не называют игру закрытым тестом", () => {
    expect(FALLBACK_TEXTS.ru).not.toMatch(/закрыт/i);
    expect(FALLBACK_TEXTS.en).not.toMatch(/closed/i);
    expect(FALLBACK_TEXTS.ru).toContain("@KennixDev");
  });
});
