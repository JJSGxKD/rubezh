import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { dayWindow, dueDay, previousDay, statsText, teamDay, type DayStats } from "../src/modules/admin-notify/daily-stats.js";
import type { DailyStatsRepository } from "../src/modules/admin-notify/daily-stats.repository.js";
import { DailyStatsReporter, type DailyStatsApi, type DailyStatsLocks } from "../src/modules/admin-notify/daily-stats.reporter.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { chatTargetOf } from "../src/platforms/ports/chat-target.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { TelegramApiError, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { targetsOf } from "./helpers/notify-targets.js";

/**
 * Ежедневная статистика (docs/35-stage4-plan.md §3.18): сутки по Москве,
 * отчёт в 00:10 один раз на все реплики, сетевой сбой — повтор, отказ
 * Telegram — без повтора; `/stats` — за сегодня, без ложной разницы.
 */

const STATS_CHAT = "-1004251205331";
const MSK = (iso: string) => Date.parse(`${iso}+03:00`);

const EMPTY: DayStats = {
  accounts: {},
  active: 0,
  sessions: 0,
  runs: { finished: 0, players: 0, medianSurvivalSec: null },
  revenue: { stars: 0, purchases: 0, refunds: 0 },
  funnel: { entered: 0, appOpened: 0, firstRun: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0 },
};

const BUSY: DayStats = {
  accounts: { organic: 7, click: 3, friend: 2 },
  active: 45,
  sessions: 120,
  runs: { finished: 230, players: 38, medianSurvivalSec: 252.4 },
  revenue: { stars: 21, purchases: 5, refunds: 1 },
  funnel: { entered: 12, appOpened: 10, firstRun: 9, runs5: 3, returnedD1: 4, returnedD7: 1, firstPurchase: 1 },
};

describe("сутки команды", () => {
  it("московские сутки — с 21:00 UTC до 21:00 UTC", () => {
    const window = dayWindow("2026-09-28");
    expect(window.from.toISOString()).toBe("2026-09-27T21:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-09-28T21:00:00.000Z");
    expect(teamDay(Date.parse("2026-09-28T21:30:00Z"))).toBe("2026-09-29");
    expect(previousDay("2026-10-01")).toBe("2026-09-30");
  });

  it("до 00:10 по Москве положен отчёт за позавчера, после — за вчера", () => {
    expect(dueDay(MSK("2026-09-29T00:09:59"))).toBe("2026-09-27");
    expect(dueDay(MSK("2026-09-29T00:10:00"))).toBe("2026-09-28");
    expect(dueDay(MSK("2026-09-29T23:59:00"))).toBe("2026-09-28");
  });
});

describe("текст отчёта", () => {
  it("цифры суток, источники по убыванию и разница с прошлыми сутками", () => {
    const text = statsText("2026-09-28", BUSY, EMPTY);
    expect(text).toContain("📊 Статистика за 28 сентября (пн)");
    expect(text).toContain("Новых аккаунтов: 12 (+12)");
    expect(text).toContain("органика 7 · ссылки 3 · друзья 2");
    expect(text).toContain("Активных: 45 (+45) · запусков 120");
    expect(text).toContain("медиана 4:12");
    expect(text).toContain("Выручка: 21 звезда (+21) · покупок 5 · возвратов 1");
    expect(statsText("2026-09-28", EMPTY, BUSY)).toContain("Новых аккаунтов: 0 (−12)");
    expect(statsText("2026-09-28", BUSY, BUSY)).toContain("Активных: 45 (=)");
  });

  it("идущие сутки — без разницы: неполный день против полного соврал бы", () => {
    const text = statsText("2026-09-29", BUSY, null);
    expect(text).toContain("📊 Сегодня, 29 сентября (вт), с полуночи");
    expect(text).not.toMatch(/\(\+|\(−|\(=\)/);
  });

  it("звёзды склоняются", () => {
    const stars = (count: number) => statsText("2026-09-28", { ...EMPTY, revenue: { stars: count, purchases: 0, refunds: 0 } }, null);
    expect(stars(1)).toContain("1 звезда");
    expect(stars(3)).toContain("3 звезды");
    expect(stars(11)).toContain("11 звёзд");
    expect(stars(25)).toContain("25 звёзд");
  });
});

class MemoryLocks implements DailyStatsLocks {
  readonly days = new Set<string>();
  readonly commands = new Set<string>();
  async claimDay(day: string): Promise<boolean> {
    if (this.days.has(day)) return false;
    this.days.add(day);
    return true;
  }
  async releaseDay(day: string): Promise<void> {
    this.days.delete(day);
  }
  async claimCommand(chatId: string): Promise<boolean> {
    if (this.commands.has(chatId)) return false;
    this.commands.add(chatId);
    return true;
  }
}

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", ADMIN_CHAT_ID: STATS_CHAT, ...env } as NodeJS.ProcessEnv);
}

function reporter(locks: DailyStatsLocks, options: { cfg?: AppConfig; fail?: () => Error | null } = {}) {
  const cfg = options.cfg ?? config();
  const sent: { chatId: string; text: string }[] = [];
  const api: DailyStatsApi = {
    async sendMessage(chat, text) {
      const failure = options.fail?.() ?? null;
      if (failure !== null) throw failure;
      sent.push({ chatId: chatTargetOf(chat).chatId, text });
      return sent.length;
    },
  };
  const repository: DailyStatsRepository = { day: async () => BUSY, series: async () => [] };
  const router = new BotRouter();
  const roles = new RolesService(cfg, new MemoryRolesRepository(), new MemoryAccountRepository());
  const instance = new DailyStatsReporter(cfg, targetsOf(cfg), router, repository, locks, api, roles);
  instance.onModuleInit();
  return { instance, sent, router };
}

describe("отчёт в 00:10", () => {
  const AFTER = MSK("2026-09-29T00:10:30");

  it("две реплики — один отчёт за сутки", async () => {
    const locks = new MemoryLocks();
    const first = reporter(locks);
    const second = reporter(locks);
    expect(await first.instance.tick(AFTER)).toBe("sent");
    expect(await second.instance.tick(AFTER)).toBe("already");
    expect(await first.instance.tick(AFTER + 60_000)).toBe("already");
    expect([...first.sent, ...second.sent]).toHaveLength(1);
    expect(first.sent[0]).toMatchObject({ chatId: STATS_CHAT, text: expect.stringContaining("Статистика за 28 сентября") });
  });

  it("сетевой сбой — повтор в следующую минуту, отказ Telegram — без повтора", async () => {
    let failure: Error | null = new TelegramApiError("sendMessage", 0, "сеть недоступна", null);
    const locks = new MemoryLocks();
    const flaky = reporter(locks, { fail: () => failure });
    expect(await flaky.instance.tick(AFTER)).toBe("failed");
    failure = null;
    expect(await flaky.instance.tick(AFTER + 60_000)).toBe("sent");

    const refused = reporter(new MemoryLocks(), { fail: () => new TelegramApiError("sendMessage", 400, "Bad Request: chat not found", null) });
    expect(await refused.instance.tick(AFTER)).toBe("failed");
    expect(await refused.instance.tick(AFTER + 60_000)).toBe("already");
  });

  it("без чата статистики — ни отметки, ни отправки: чат зададут в панели, и отчёт уйдёт", async () => {
    const locks = new MemoryLocks();
    const silent = reporter(locks, { cfg: config({ ADMIN_CHAT_ID: "" }) });
    expect(await silent.instance.tick(AFTER)).toBe("no_chat");
    expect(locks.days.size).toBe(0);
  });
});

describe("/stats", () => {
  const command = (chat: { id: number; type: string }, fromId: number): TelegramUpdate => ({
    update_id: 1,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: "/stats", chat, from: { id: fromId, is_bot: false } },
  });

  it("в чате статистики отвечает любому участнику — за сегодня, без разницы; повтор сразу — молчание", async () => {
    const bot = reporter(new MemoryLocks());
    await bot.router.dispatch(command({ id: Number(STATS_CHAT), type: "supergroup" }, 999));
    await bot.router.dispatch(command({ id: Number(STATS_CHAT), type: "supergroup" }, 999));
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.text).toContain("с полуночи");
  });

  it("в личке — только тому, кому аналитика открыта ролью; в чужой группе — молчание", async () => {
    const bot = reporter(new MemoryLocks(), { cfg: config({ ADMIN_TELEGRAM_IDS: "111" }) });
    await bot.router.dispatch(command({ id: 222, type: "private" }, 222));
    await bot.router.dispatch(command({ id: -100999, type: "group" }, 111));
    expect(bot.sent).toHaveLength(0);
    await bot.router.dispatch(command({ id: 111, type: "private" }, 111));
    expect(bot.sent).toHaveLength(1);
  });
});
