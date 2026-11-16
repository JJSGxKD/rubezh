import { describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { FeedbackBotCommand, type FeedbackBotApi } from "../src/modules/feedback/feedback-bot.command.js";
import type { FeedbackRepository } from "../src/modules/feedback/feedback.repository.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import { chatTargetOf, type ChatRef } from "../src/platforms/ports/chat-target.js";
import { BotCommands, type CommandsBotApi } from "../src/platforms/telegram/bot-commands.js";
import { BotRouter, type BotCommandSpec, type BotUpdateHandler } from "../src/platforms/telegram/bot-router.js";
import { TeamEphemeral, type TeamEphemeralApi } from "../src/platforms/telegram/team-ephemeral.js";
import { TelegramApiError, TelegramBotApi, updateSchema, type BotCommand, type FetchLike, type SendOptions, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { panelSettings } from "./helpers/settings.js";
import { targetsOf } from "./helpers/notify-targets.js";

// Эфемерные ответы в чате команды (docs/35-stage4-plan.md Р199, tasks/T-0407).

const ADMIN = "645259468";
const TEAM_CHAT = "-1004251205331";
const ON: Record<string, SettingValue> = { "bot.formats.enabled": true, "bot.team-ephemeral.enabled": true };

type Sent = { chatId: string; threadId: number | null; text: string; options: SendOptions | undefined };

function config(): AppConfig {
  return loadAppConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "1:TEST",
    TELEGRAM_BOT_UPDATES: "polling",
    ADMIN_CHAT_ID: `${TEAM_CHAT}:57`,
    ADMIN_TELEGRAM_IDS: ADMIN,
    DATABASE_URL: "postgresql://unused",
  });
}

function fakeApi(failure: () => Error | null) {
  const sent: Sent[] = [];
  const answers: { id: string; text: string | undefined }[] = [];
  const menus: { chat: string | null; commands: BotCommand[]; language?: string }[] = [];
  const api: TeamEphemeralApi & CommandsBotApi & FeedbackBotApi = {
    async sendMessage(chat: ChatRef, text: string, _signal, options) {
      const target = chatTargetOf(chat);
      const error = options?.ephemeral === undefined ? null : failure();
      if (error !== null) throw error;
      sent.push({ chatId: target.chatId, threadId: target.threadId, text, options });
      return sent.length;
    },
    async answerCallbackQuery(id, text) {
      answers.push({ id, text });
    },
    async setMyCommands(commands, chat, _signal, language) {
      menus.push({ chat: chat === null ? null : chatTargetOf(chat).chatId, commands, ...(language === undefined ? {} : { language }) });
    },
    async sendDocument() {},
  };
  return { api, sent, answers, menus };
}

function build(values: Record<string, SettingValue> = ON, failure: () => Error | null = () => null) {
  const fake = fakeApi(failure);
  const cfg = config();
  const team = new TeamEphemeral(panelSettings(values), targetsOf(cfg), fake.api);
  const warn = vi.spyOn(team["logger"], "warn").mockImplementation(() => undefined);
  const log = vi.spyOn(team["logger"], "log").mockImplementation(() => undefined);
  return { ...fake, team, cfg, warn, log };
}

function textMessage(chatId: string, type: string, text = "/help", extra: Record<string, unknown> = {}): NonNullable<TelegramUpdate["message"]> {
  return { message_id: 1, date: 1, text, chat: { id: Number(chatId), type }, from: { id: 999, is_bot: false }, message_thread_id: 57, ...extra };
}

function pressOf(chatId: string, type: string): NonNullable<TelegramUpdate["callback_query"]> {
  return { id: "cb-1", from: { id: 999, is_bot: false }, data: "export:day", message: { message_id: 5, chat: { id: Number(chatId), type }, message_thread_id: 57 } };
}

const refused = (code: number) => () => new TelegramApiError("sendMessage", code, "Bad Request", null);

describe("TeamEphemeral.enabled", () => {
  it("истина только при обоих ключах", () => {
    expect(build(ON).team.enabled()).toBe(true);
    expect(build({ "bot.formats.enabled": true, "bot.team-ephemeral.enabled": false }).team.enabled()).toBe(false);
    expect(build({ "bot.formats.enabled": false, "bot.team-ephemeral.enabled": true }).team.enabled()).toBe(false);
  });

  it("по умолчанию общий выключатель выкл. — эфемерных ответов нет", () => {
    expect(build({}).team.enabled()).toBe(false);
  });

  it("слушатель смены зовётся только для своих ключей", () => {
    const listeners: ((changed: readonly string[]) => void)[] = [];
    const settings = { ...panelSettings(ON), onChange: (listener: (changed: readonly string[]) => void) => void listeners.push(listener) };
    const team = new TeamEphemeral(settings, targetsOf(config()), fakeApi(() => null).api);
    const heard = vi.fn();
    team.onSwitchChange(heard);
    for (const listener of listeners) listener(["notify.reports"]);
    expect(heard).not.toHaveBeenCalled();
    for (const listener of listeners) listener(["bot.team-ephemeral.enabled"]);
    for (const listener of listeners) listener(["bot.formats.enabled"]);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe("TeamEphemeral.tryReply", () => {
  it("в чате команды отвечает эфемерно в ту же тему", async () => {
    const bot = build();
    expect(await bot.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "Справка")).toBe(true);
    expect(bot.sent).toEqual([{ chatId: TEAM_CHAT, threadId: 57, text: "Справка", options: { ephemeral: { receiverUserId: 999 } } }]);
  });

  it("эфемерная команда — ответ с её ephemeral_message_id", async () => {
    const bot = build();
    await bot.team.tryReply(textMessage(TEAM_CHAT, "supergroup", "/help", { ephemeral_message_id: 9 }), "Справка");
    expect(bot.sent[0]?.options?.ephemeral).toEqual({ receiverUserId: 999, replyToEphemeralId: 9 });
  });

  it("клавиатура уходит вместе с ответом", async () => {
    const bot = build();
    const keyboard = [[{ text: "Сутки", callback_data: "export:day" }]];
    await bot.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "Меню", { keyboard });
    expect(bot.sent[0]?.options?.keyboard).toEqual(keyboard);
  });

  it("чужая группа, личка, выключенный ключ и сообщение без автора — false без вызова API", async () => {
    const on = build();
    expect(await on.team.tryReply(textMessage("-100999", "supergroup"), "x")).toBe(false);
    expect(await on.team.tryReply(textMessage(ADMIN, "private"), "x")).toBe(false);
    const { from: _from, ...anonymous } = textMessage(TEAM_CHAT, "supergroup");
    expect(await on.team.tryReply(anonymous, "x")).toBe(false);
    const off = build({ "bot.formats.enabled": true, "bot.team-ephemeral.enabled": false });
    expect(await off.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "x")).toBe(false);
    expect([...on.sent, ...off.sent]).toEqual([]);
  });

  it("отказ площадки 400 или 403 — false, а в лог попадает один раз за процесс", async () => {
    const bot = build(ON, refused(400));
    expect(await bot.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "x")).toBe(false);
    expect(await bot.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "x")).toBe(false);
    expect(bot.warn).toHaveBeenCalledTimes(1);
    expect(String(bot.warn.mock.calls[0]?.[0])).toContain("team_ephemeral_refused");
    const forbidden = build(ON, refused(403));
    expect(await forbidden.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "x")).toBe(false);
  });

  it("прочая ошибка бросается — задание очереди повторит", async () => {
    const bot = build(ON, refused(500));
    await expect(bot.team.tryReply(textMessage(TEAM_CHAT, "supergroup"), "x")).rejects.toBeInstanceOf(TelegramApiError);
  });
});

describe("TeamEphemeral.answerPress", () => {
  it("в чате команды — эфемерное сообщение нажавшему и один пустой answerCallbackQuery", async () => {
    const bot = build();
    await bot.team.answerPress(pressOf(TEAM_CHAT, "supergroup"), "Готовлю выгрузку — пришлю в личку.");
    expect(bot.sent).toEqual([
      { chatId: TEAM_CHAT, threadId: 57, text: "Готовлю выгрузку — пришлю в личку.", options: { ephemeral: { receiverUserId: 999, callbackQueryId: "cb-1" } } },
    ]);
    expect(bot.answers).toEqual([{ id: "cb-1", text: undefined }]);
  });

  it("в личке — только всплывающая подсказка", async () => {
    const bot = build();
    await bot.team.answerPress(pressOf(ADMIN, "private"), "Готовлю выгрузку");
    expect(bot.sent).toEqual([]);
    expect(bot.answers).toEqual([{ id: "cb-1", text: "Готовлю выгрузку" }]);
  });

  it("отказ площадки — прежняя подсказка, answerCallbackQuery ровно один", async () => {
    const bot = build(ON, refused(400));
    await bot.team.answerPress(pressOf(TEAM_CHAT, "supergroup"), "Текст");
    expect(bot.answers).toEqual([{ id: "cb-1", text: "Текст" }]);
  });

  it("выключенный ключ — подсказка, как до задачи", async () => {
    const bot = build({});
    await bot.team.answerPress(pressOf(TEAM_CHAT, "supergroup"), "Текст");
    expect(bot.sent).toEqual([]);
    expect(bot.answers).toEqual([{ id: "cb-1", text: "Текст" }]);
  });
});

function handler(name: string, commands: BotCommandSpec[]): BotUpdateHandler {
  return { name, commands, handle: async () => false };
}

function helpWith(values: Record<string, SettingValue>, failure: () => Error | null = () => null) {
  const bot = build(values, failure);
  const router = new BotRouter();
  const help = new BotCommands(bot.cfg, targetsOf(bot.cfg), router, bot.api, bot.team);
  help.onModuleInit();
  router.register(handler("stats", [{ command: "stats", description: "Сводка плейтеста", audience: "admin" }]));
  return { ...bot, help, router };
}

function helpMessage(extra: Record<string, unknown> = {}): TelegramUpdate {
  return { update_id: 1, message: textMessage(TEAM_CHAT, "supergroup", "/help", extra) };
}

describe("/help и меню команд в чате команды", () => {
  it("меню чата команды: /help эфемерный, /stats нет; остальные меню без поля", async () => {
    const bot = helpWith(ON);
    await bot.help.publish();
    const teamMenu = bot.menus.find((menu) => menu.chat === TEAM_CHAT);
    expect(teamMenu?.commands.find((item) => item.command === "help")?.is_ephemeral).toBe(true);
    expect(teamMenu?.commands.find((item) => item.command === "stats")).not.toHaveProperty("is_ephemeral");
    for (const menu of bot.menus.filter((item) => item.chat !== TEAM_CHAT)) {
      for (const item of menu.commands) expect(item).not.toHaveProperty("is_ephemeral");
    }
  });

  it("при выключенных ключах поля нет нигде", async () => {
    const bot = helpWith({});
    await bot.help.publish();
    for (const menu of bot.menus) for (const item of menu.commands) expect(item).not.toHaveProperty("is_ephemeral");
  });

  it("/help в чате команды — один эфемерный ответ", async () => {
    const bot = helpWith(ON);
    await bot.router.dispatch(helpMessage({ ephemeral_message_id: 4 }));
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.options?.ephemeral).toEqual({ receiverUserId: 999, replyToEphemeralId: 4 });
  });

  it("/help старого клиента — эфемерный ответ без replyToEphemeralId", async () => {
    const bot = helpWith(ON);
    await bot.router.dispatch(helpMessage());
    expect(bot.sent[0]?.options?.ephemeral).toEqual({ receiverUserId: 999 });
  });

  it("отказ 400 (бот не администратор) — публичный ответ в ту же тему", async () => {
    const bot = helpWith(ON, refused(400));
    await bot.router.dispatch(helpMessage());
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]).toMatchObject({ chatId: TEAM_CHAT, threadId: 57 });
    expect(bot.sent[0]?.options).toBeUndefined();
  });
});

describe("/feedback в чате команды", () => {
  function feedbackBot() {
    const bot = build();
    const router = new BotRouter();
    const repository = { recent: vi.fn(async () => []) } as unknown as FeedbackRepository;
    new FeedbackBotCommand(bot.cfg, router, bot.api, repository, bot.team).onModuleInit();
    return { ...bot, router };
  }
  const feedback = (chatId: string, type: string, fromId: string): TelegramUpdate => ({
    update_id: 1,
    message: { ...textMessage(chatId, type, "/feedback"), from: { id: Number(fromId), is_bot: false } },
  });

  it("администратору — эфемерная подсказка вместо публичного отказа", async () => {
    const bot = feedbackBot();
    await bot.router.dispatch(feedback(TEAM_CHAT, "supergroup", ADMIN));
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.options?.ephemeral?.receiverUserId).toBe(Number(ADMIN));
    expect(bot.sent[0]?.text).toContain("/feedback");
  });

  it("не-администратору — эфемерный отказ", async () => {
    const bot = feedbackBot();
    await bot.router.dispatch(feedback(TEAM_CHAT, "supergroup", "999"));
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.options?.ephemeral?.receiverUserId).toBe(999);
    expect(bot.sent[0]?.text).toContain("администраторы");
  });

  it("не-администратору в чужой группе — молчание", async () => {
    const bot = feedbackBot();
    await bot.router.dispatch(feedback("-100999", "supergroup", "999"));
    expect(bot.sent).toEqual([]);
  });
});

describe("TelegramBotApi: разбор эфемерной команды и ответ на неё", () => {
  it("sendMessage с replyToEphemeralId несёт reply_parameters и параметры получателя", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 3, date: 1, chat: { id: 5, type: "supergroup" } } }));
    };
    const api = new TelegramBotApi("123:TOKEN", "https://api.telegram.org", fetchImpl);
    await api.sendMessage({ chatId: "5", threadId: null }, "x", undefined, { ephemeral: { receiverUserId: 5, replyToEphemeralId: 9 } });
    expect(bodies[0]).toMatchObject({
      reply_parameters: { ephemeral_message_id: 9 },
      ephemeral_message_parameters: { receiver_user_id: 5 },
    });
  });

  it("updateSchema пропускает сообщение с ephemeral_message_id и нулевым message_id", () => {
    const parsed = updateSchema.parse({
      update_id: 1,
      message: { message_id: 0, ephemeral_message_id: 9, date: 1, text: "/help", chat: { id: 5, type: "supergroup" } },
    });
    expect(parsed.message?.ephemeral_message_id).toBe(9);
  });
});
