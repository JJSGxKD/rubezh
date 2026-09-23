import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { BotRouter } from "../src/modules/bot/bot-router.js";
import {
  ExportBotCommand,
  periodOf,
  type ExportBotApi,
  type ExportBotLocks,
  type ExportJob,
} from "../src/modules/export/export-bot.command.js";
import type { ExportArtifact, ExportRequest, ExportService } from "../src/modules/export/export.service.js";
import { chatTargetOf } from "../src/modules/telegram/chat-target.js";
import type { TelegramUpdate } from "../src/modules/telegram/telegram-bot-api.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

// Выгрузка через бота (docs/28-diagnostics.md §6.1.5).

const ADMIN = 111;
const STRANGER = 222;

class MemoryLocks implements ExportBotLocks {
  readonly held = new Set<string>();
  readonly cooldowns = new Set<string>();
  async claim(adminId: string): Promise<boolean> {
    if (this.held.has(adminId)) return false;
    this.held.add(adminId);
    return true;
  }
  async release(adminId: string): Promise<void> {
    this.held.delete(adminId);
  }
  async cooldownLeft(adminId: string): Promise<number> {
    return this.cooldowns.has(adminId) ? 240 : 0;
  }
  async startCooldown(adminId: string): Promise<void> {
    this.cooldowns.add(adminId);
  }
}

type Call = { method: string; chatId?: string; text?: string; keyboard?: unknown; name?: string };

function setup(env: Record<string, string> = {}, parts = 1) {
  const config = loadAppConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "123:TEST",
    TELEGRAM_BOT_UPDATES: "polling",
    DATA_EXPORT_BOT_ENABLED: "true",
    EXPORT_PSEUDONYM_KEY: "a".repeat(64),
    DATABASE_URL: "postgresql://unused",
    ADMIN_TELEGRAM_IDS: String(ADMIN),
    ...env,
  });
  const calls: Call[] = [];
  const api: ExportBotApi = {
    async sendMessage(chat, text, _signal, options) {
      calls.push({ method: "sendMessage", chatId: chatTargetOf(chat).chatId, text, keyboard: options?.keyboard });
      return calls.length;
    },
    async editMessageText(chat, _messageId, text) {
      calls.push({ method: "editMessageText", chatId: chatTargetOf(chat).chatId, text });
    },
    async answerCallbackQuery(_id, text) {
      calls.push({ method: "answerCallbackQuery", ...(text === undefined ? {} : { text }) });
    },
    async sendDocument(chat, _path, name, text) {
      calls.push({ method: "sendDocument", chatId: chatTargetOf(chat).chatId, name, text });
    },
    async setMyCommands() {},
  };
  const builds: ExportRequest[] = [];
  const journal: string[] = [];
  let cleaned = 0;
  let failBuild: Error | null = null;
  const exports = {
    async build(request: ExportRequest): Promise<ExportArtifact> {
      if (failBuild !== null) throw failBuild;
      builds.push(request);
      return {
        exportId: "e1e2e3e4-0000-4000-8000-000000000000",
        period: request.period,
        fileName: "rubezh-export.zip",
        parts: Array.from({ length: parts }, (_, index) => `/tmp/part-${index}`),
        sizeBytes: 90 * 1024 * 1024,
        counts: { events: 1200, reports: 3, runs: 40 },
        appVersions: ["0.4.0"],
        cleanup: async () => {
          cleaned++;
        },
      };
    },
    async finish(_id: string, result: { status: string }) {
      journal.push(result.status);
    },
    async sinceLastExport(_admin: string, now: Date) {
      return { from: new Date("2026-09-14T00:00:00Z"), to: now };
    },
  } as unknown as ExportService;
  const locks = new MemoryLocks();
  const router = new BotRouter();
  const command = new ExportBotCommand(config, router, locks, api, exports, rolesService(config));
  const jobs: ExportJob[] = [];
  command.jobs = { add: async (job) => void jobs.push(job) };
  command.onModuleInit();
  return {
    command,
    router,
    calls,
    jobs,
    builds,
    journal,
    locks,
    cleaned: () => cleaned,
    failBuild: (error: Error) => (failBuild = error),
  };
}

function message(fromId: number, text: string, chat: { id: number; type: string } = { id: fromId, type: "private" }): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, date: 1, text, chat, from: { id: fromId, is_bot: false } } };
}

function press(fromId: number, data: string, chat: { id: number; type: string } = { id: fromId, type: "private" }): TelegramUpdate {
  return { update_id: 2, callback_query: { id: `cb-${Math.random()}`, from: { id: fromId, is_bot: false }, data, message: { message_id: 5, chat } } };
}

/**
 * Права выгрузки: ролей в базе нет, поэтому работает аварийный путь —
 * список ADMIN_TELEGRAM_IDS даёт владельца, пока владельца нет
 * (docs/34-stage3-plan.md, WP2).
 */
function rolesService(config: AppConfig): RolesService {
  return new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
}

describe("выгрузка через бота", () => {
  it("не-администратору молчит: существование выгрузки не раскрывается", async () => {
    const bot = setup();
    await bot.router.dispatch(message(STRANGER, "/export"));
    expect(bot.calls).toEqual([]);
  });

  it("администратору в группе — отказ без данных", async () => {
    const bot = setup();
    await bot.router.dispatch(message(ADMIN, "/export", { id: -100500, type: "supergroup" }));
    expect(bot.calls).toEqual([{ method: "sendMessage", chatId: "-100500", text: expect.stringContaining("только в личном чате"), keyboard: undefined }]);
    expect(bot.jobs).toEqual([]);
  });

  it("в личке показывает выбор периода", async () => {
    const bot = setup();
    await bot.router.dispatch(message(ADMIN, "/export"));
    const keyboard = bot.calls[0]?.keyboard as { callback_data: string }[][];
    expect(keyboard.flat().map((button) => button.callback_data)).toEqual(["export:day", "export:week", "export:since", "export:all"]);
  });

  it("подделанное нажатие не-администратора и нажатие в группе ничего не запускают", async () => {
    const bot = setup();
    await bot.router.dispatch(press(STRANGER, "export:all"));
    await bot.router.dispatch(press(ADMIN, "export:all", { id: -100500, type: "supergroup" }));
    expect(bot.jobs).toEqual([]);
    expect(bot.calls.every((call) => call.method === "answerCallbackQuery" && call.text === undefined)).toBe(true);
  });

  it("двойное нажатие даёт одну задачу, а после выгрузки — пауза", async () => {
    const bot = setup();
    await bot.router.dispatch(press(ADMIN, "export:day"));
    await bot.router.dispatch(press(ADMIN, "export:day"));
    expect(bot.jobs).toHaveLength(1);
    expect(bot.calls).toContainEqual({ method: "answerCallbackQuery", text: "Выгрузка уже готовится" });

    await bot.command.run(bot.jobs[0]!);
    await bot.router.dispatch(press(ADMIN, "export:week"));
    expect(bot.jobs).toHaveLength(1);
    expect(bot.calls.at(-1)?.text).toContain("Следующая — через 4 мин");
  });

  it("отправляет части документами с подписью и отмечает выгрузку в журнале", async () => {
    const bot = setup({}, 2);
    await bot.router.dispatch(press(ADMIN, "export:since"));
    await bot.command.run(bot.jobs[0]!);

    expect(bot.builds[0]).toMatchObject({ source: "bot", requestedBy: String(ADMIN), period: { from: new Date("2026-09-14T00:00:00Z") } });
    const documents = bot.calls.filter((call) => call.method === "sendDocument");
    expect(documents.map((call) => call.name)).toEqual(["rubezh-export.zip.001", "rubezh-export.zip.002"]);
    expect(documents[0]?.text).toContain("часть 1 из 2");
    expect(documents[0]?.text).toContain("Событий 1200, отчётов 3, забегов 40");
    expect(bot.calls.at(-1)).toMatchObject({ method: "editMessageText", text: expect.stringContaining("частей 2") });
    expect(bot.journal).toEqual(["sent"]);
    expect(bot.cleaned()).toBe(1);
    expect(bot.locks.held.size).toBe(0);
  });

  it("упавшая сборка снимает лок без паузы и честно пишет об этом", async () => {
    const bot = setup();
    bot.failBuild(new Error("statement timeout"));
    await bot.router.dispatch(press(ADMIN, "export:all"));
    await bot.command.run(bot.jobs[0]!);
    expect(bot.calls.at(-1)).toEqual({ method: "editMessageText", chatId: String(ADMIN), text: "Выгрузка не собралась — причина в логе бэкенда." });
    expect(bot.locks.held.size).toBe(0);
    expect(bot.locks.cooldowns.size).toBe(0);
  });

  it("выключенная выгрузка не отвечает на команду", async () => {
    const bot = setup({ DATA_EXPORT_BOT_ENABLED: "false" });
    await bot.router.dispatch(message(ADMIN, "/export"));
    expect(bot.calls).toEqual([]);
  });

  it("считает периоды от момента запроса", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(periodOf("day", now)).toEqual({ from: new Date("2026-09-14T12:00:00Z"), to: now });
    expect(periodOf("all", now)).toEqual({ from: null, to: now });
    expect(periodOf("since", now)).toBeNull();
  });
});
