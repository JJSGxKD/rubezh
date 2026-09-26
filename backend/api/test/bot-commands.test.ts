import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotCommands, helpText, type CommandsBotApi } from "../src/platforms/telegram/bot-commands.js";
import { BotRouter, type BotCommandSpec, type BotUpdateHandler } from "../src/platforms/telegram/bot-router.js";
import { chatTargetOf, type ChatRef } from "../src/platforms/telegram/chat-target.js";
import type { TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";

// /help и меню команд (docs/28-diagnostics.md §6.1.2): в чате администраторов
// бот отвечает всем участникам, и половина команд — не для всех.

const ADMIN = "645259468";
const ADMIN_CHAT = "-1004251205331";

function handler(name: string, commands: BotCommandSpec[]): BotUpdateHandler {
  return { name, commands, handle: async () => false };
}

function setup(env: Record<string, string> = {}) {
  const config = loadAppConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "1:TEST",
    TELEGRAM_BOT_UPDATES: "polling",
    ADMIN_CHAT_ID: `${ADMIN_CHAT}:57`,
    ADMIN_TELEGRAM_IDS: ADMIN,
    ...env,
  });
  const sent: { chatId: string; threadId: number | null; text: string }[] = [];
  const menus: { chat: string | null; commands: string[]; language?: string; descriptions?: string[] }[] = [];
  const api: CommandsBotApi = {
    async sendMessage(chat: ChatRef, text: string) {
      const target = chatTargetOf(chat);
      sent.push({ chatId: target.chatId, threadId: target.threadId, text });
      return sent.length;
    },
    async setMyCommands(commands, chat, _signal, language) {
      menus.push({
        chat: chat === null ? null : chatTargetOf(chat).chatId,
        commands: commands.map((item) => item.command),
        ...(language === undefined ? {} : { language, descriptions: commands.map((item) => item.description) }),
      });
    },
  };
  const router = new BotRouter();
  const help = new BotCommands(config, router, api);
  help.onModuleInit();
  router.register(handler("start", [{ command: "start", description: "Открыть игру", descriptionEn: "Open the game", audience: "everyone" }]));
  router.register(handler("stats", [{ command: "stats", description: "Сводка плейтеста", audience: "admin" }]));
  router.register(handler("export", [{ command: "export", description: "Выгрузка данных закрытого теста", audience: "admin" }]));
  return { help, router, sent, menus };
}

function command(chatId: string, type: string, fromId: string, threadId?: number): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      text: "/help",
      chat: { id: Number(chatId), type },
      from: { id: Number(fromId), is_bot: false },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    },
  };
}

describe("/help", () => {
  it("в чате администраторов показывает оба списка и отвечает в ту же тему", async () => {
    const bot = setup();
    await bot.router.dispatch(command(ADMIN_CHAT, "supergroup", "999", 57));

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]).toMatchObject({ chatId: ADMIN_CHAT, threadId: 57 });
    expect(bot.sent[0]?.text).toContain("/start — Открыть игру");
    expect(bot.sent[0]?.text).toContain("Для администраторов:");
    expect(bot.sent[0]?.text).toContain("/export — Выгрузка данных закрытого теста");
  });

  it("обычному игроку в личке — только его команды", async () => {
    const bot = setup();
    await bot.router.dispatch(command("777", "private", "777"));
    expect(bot.sent[0]?.text).toContain("/start");
    expect(bot.sent[0]?.text).not.toContain("/export");
    expect(bot.sent[0]?.text).not.toContain("Для администраторов");
  });

  it("администратору в личке — оба списка, в чужой группе — только общий", async () => {
    const bot = setup();
    await bot.router.dispatch(command(ADMIN, "private", ADMIN));
    await bot.router.dispatch(command("-100999", "supergroup", ADMIN));
    expect(bot.sent[0]?.text).toContain("Для администраторов");
    expect(bot.sent[1]?.text).not.toContain("Для администраторов");
  });

  it("меню Telegram: всем — общие команды, чату администраторов и их личкам — все", async () => {
    const bot = setup();
    await bot.help.publish();
    expect(bot.menus).toEqual([
      { chat: null, commands: ["help", "start"] },
      // Английский интерфейс — те же общие команды своими описаниями.
      { chat: null, commands: ["help", "start"], language: "en", descriptions: ["What the bot can do", "Open the game"] },
      { chat: ADMIN_CHAT, commands: ["help", "start", "stats", "export"] },
      { chat: ADMIN, commands: ["help", "start", "stats", "export"] },
    ]);
  });

  it("список команд — из зарегистрированных обработчиков, без них /help пуст", () => {
    expect(helpText([], false)).toContain("Команды:");
    expect(helpText([{ command: "start", description: "Открыть игру", audience: "everyone" }], true)).not.toContain("Для администраторов");
  });
});
