import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { ACCOUNT_SETTINGS_VERSION } from "../src/modules/account-settings/account-settings.catalog.js";
import { botMessageOf, DIFFICULTY_NAMES, REMINDER_OFF_ACTION } from "../src/modules/notifications-bot/bot-notify-texts.js";
import { NOTIFICATION_KINDS } from "../src/modules/notifications/notification-kinds.js";
import {
  chooseKind,
  closingDay,
  isQuietHour,
  overtaken,
  REMINDER_KINDS,
  REMINDER_OFF_DATA,
  SNAPSHOT_TOP,
  type CurrentPlace,
  type ReminderKind,
  type SnapshotEntry,
} from "../src/modules/reminders/reminder-rules.js";
import type { DaySummary, ReminderTarget, RemindersRepository } from "../src/modules/reminders/reminders.repository.js";
import { RemindersReport, reportText } from "../src/modules/reminders/reminders.report.js";
import { RemindersScanner } from "../src/modules/reminders/reminders.scanner.js";
import { RemindersStore } from "../src/modules/reminders/reminders.store.js";
import type { SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { seasonOf } from "../src/modules/seasons/season-rules.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import type { ChatTarget } from "../src/platforms/ports/chat-target.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { RemindersOffCommand, type RemindersOffBotApi } from "../src/platforms/telegram/reminders-off.command.js";
import type { TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramMessenger, type MessengerBotApi } from "../src/platforms/telegram/telegram-messenger.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Напоминания через бота (tasks/T-0128): чистые правила, тексты, кнопка
 * действия в порту и Telegram, команда «Не напоминать», проход планировщика и
 * суточный отчёт — на памяти. Живой Postgres и Redis — `reminders.integration.test.ts`.
 *
 * Время — московское: 10:00 по Москве — 07:00 UTC.
 */

const MSK = (day: number, hour: number, minute = 0): Date => new Date(Date.UTC(2026, 10, day, hour - 3, minute));

describe("тихие часы", () => {
  it("21 → 10: 20:59 не тихо, 21:00 тихо, 09:59 тихо, 10:00 не тихо", () => {
    expect(isQuietHour(MSK(4, 20, 59), 21, 10)).toBe(false);
    expect(isQuietHour(MSK(4, 21, 0), 21, 10)).toBe(true);
    expect(isQuietHour(MSK(4, 23, 30), 21, 10)).toBe(true);
    expect(isQuietHour(MSK(5, 0, 0), 21, 10)).toBe(true);
    expect(isQuietHour(MSK(5, 9, 59), 21, 10)).toBe(true);
    expect(isQuietHour(MSK(5, 10, 0), 21, 10)).toBe(false);
  });

  it("from == to — тихих часов нет никогда", () => {
    for (const hour of [0, 5, 10, 21, 23]) expect(isQuietHour(MSK(4, hour), 8, 8)).toBe(false);
  });

  it("окно без перехода через полночь: 1 → 5", () => {
    expect(isQuietHour(MSK(4, 0, 59), 1, 5)).toBe(false);
    expect(isQuietHour(MSK(4, 1, 0), 1, 5)).toBe(true);
    expect(isQuietHour(MSK(4, 4, 59), 1, 5)).toBe(true);
    expect(isQuietHour(MSK(4, 5, 0), 1, 5)).toBe(false);
    expect(isQuietHour(MSK(4, 12, 0), 1, 5)).toBe(false);
  });

  it("час считается по Москве, а не по UTC: 18:00 UTC — это 21:00", () => {
    expect(isQuietHour(new Date(Date.UTC(2026, 10, 4, 18, 0)), 21, 10)).toBe(true);
    expect(isQuietHour(new Date(Date.UTC(2026, 10, 4, 17, 59)), 21, 10)).toBe(false);
  });
});

describe("игровой день перед закрытием сезона", () => {
  const season = { endsAt: new Date("2026-11-09T00:00:00Z") };

  it("сезон до 2026-11-09T00:00Z закрывается в 03:00 понедельника по Москве — день перед ним воскресенье", () => {
    expect(closingDay(season)).toBe("2026-11-08");
  });

  it("понедельник по Москве (2026-11-08T21:00Z) — уже не день перед закрытием", () => {
    const gameDay = (at: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(at);
    expect(gameDay(new Date("2026-11-08T20:59:00Z"))).toBe(closingDay(season));
    expect(gameDay(new Date("2026-11-08T21:00:00Z"))).not.toBe(closingDay(season));
  });
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

describe("обогнали в таблице недели", () => {
  const before: SnapshotEntry[] = [
    { accountId: A, rank: 3, score: 100 },
    { accountId: B, rank: 4, score: 90 },
  ];

  it("место ухудшилось при том же результате — в списке, с новым местом", () => {
    const now = new Map<string, CurrentPlace>([
      [A, { rank: 4, score: 100 }],
      [B, { rank: 3, score: 95 }],
    ]);
    expect(overtaken(before, now)).toEqual([{ accountId: A, place: 4 }]);
  });

  it("результат вырос — не «обогнан», даже если место хуже", () => {
    expect(overtaken(before, new Map([[A, { rank: 9, score: 130 }]]))).toEqual([]);
  });

  it("вышел за сотню мест при том же результате — в списке", () => {
    const edge: SnapshotEntry[] = [{ accountId: C, rank: SNAPSHOT_TOP, score: 50 }];
    expect(overtaken(edge, new Map([[C, { rank: 130, score: 50 }]]))).toEqual([{ accountId: C, place: 130 }]);
  });

  it("первый тик без снимка — пусто", () => {
    expect(overtaken(null, new Map([[A, { rank: 4, score: 100 }]]))).toEqual([]);
  });

  it("место то же или лучше, игрока в таблице больше нет — не обогнан", () => {
    const now = new Map<string, CurrentPlace>([[A, { rank: 3, score: 100 }]]);
    expect(overtaken(before, now)).toEqual([]);
    expect(overtaken(before, new Map([[A, { rank: 1, score: 100 }]]))).toEqual([]);
  });
});

describe("какое напоминание выбрать игроку", () => {
  const free = { canMessage: true, optedOut: false, windowBusy: false } as const;

  it("по приоритету: обогнали → сезон закрывается → награда дня", () => {
    expect(chooseKind({ ...free, kinds: ["daily_reward_ready", "season_overtaken"] })).toBe("season_overtaken");
    expect(chooseKind({ ...free, kinds: ["daily_reward_ready", "season_closing"] })).toBe("season_closing");
    expect(chooseKind({ ...free, kinds: ["season_closing", "season_overtaken", "daily_reward_ready"] })).toBe("season_overtaken");
    expect(chooseKind({ ...free, kinds: ["daily_reward_ready"] })).toBe("daily_reward_ready");
  });

  it("занятое окно потолка, отписка, нет разрешения писать и нет подходящих видов — не выбирается", () => {
    const kinds: ReminderKind[] = ["season_overtaken", "daily_reward_ready"];
    expect(chooseKind({ ...free, kinds, windowBusy: true })).toBeNull();
    expect(chooseKind({ ...free, kinds, optedOut: true })).toBeNull();
    expect(chooseKind({ ...free, kinds, canMessage: false })).toBeNull();
    expect(chooseKind({ ...free, kinds: [] })).toBeNull();
  });
});

const ZERO = { launch: (param: string): string | null => `https://t.me/rubezh_bot/play?startapp=${param}` };

describe("тексты напоминаний", () => {
  const closing = { endsAt: "2026-11-09T00:00:00.000Z" };

  it("три сообщения: подстановка, простой текст, кнопка в игру с параметром вида", () => {
    const overtakenMessage = botMessageOf("season_overtaken", { difficulty: "hard", place: 4 }, ZERO.launch);
    expect(overtakenMessage).toEqual({
      text: "Тебя обогнали в недельном сезоне «Рубежа»: на сложности «Сложная» ты теперь на 4-м месте. До закрытия сезона можно отыграться.",
      button: { text: "▶ Открыть игру", url: "https://t.me/rubezh_bot/play?startapp=n-season_overtaken" },
    });
    expect(botMessageOf("season_closing", closing, ZERO.launch)?.text).toBe(
      "Недельный сезон «Рубежа» закрывается завтра в 03:00 по Москве. Награды за порог и за место получат те, кто попал в таблицу, — успей улучшить результат.",
    );
    expect(botMessageOf("daily_reward_ready", {}, ZERO.launch)).toEqual({
      text: "Награда дня ждёт тебя в «Рубеже». Загляни и забери её сегодня.",
      button: { text: "▶ Открыть игру", url: "https://t.me/rubezh_bot/play?startapp=n-daily_reward_ready" },
    });
  });

  it("без разметки и не длиннее предела Telegram", () => {
    const messages = [
      botMessageOf("season_overtaken", { difficulty: "easy", place: 100_000 }, ZERO.launch),
      botMessageOf("season_closing", closing, ZERO.launch),
      botMessageOf("daily_reward_ready", {}, ZERO.launch),
    ];
    for (const message of messages) {
      expect(message).not.toBeNull();
      expect(message?.text.length).toBeLessThanOrEqual(4096);
      expect(message?.text).not.toMatch(/[<>*_`\\]/);
    }
  });

  it("данные не по схеме — писать нечего", () => {
    expect(botMessageOf("season_overtaken", { difficulty: "legend", place: 4 }, ZERO.launch)).toBeNull();
    expect(botMessageOf("season_overtaken", { difficulty: "hard", place: 0 }, ZERO.launch)).toBeNull();
    expect(botMessageOf("season_closing", { endsAt: "завтра" }, ZERO.launch)).toBeNull();
  });

  it("нет ссылки на игру — сообщение уходит без кнопки", () => {
    expect(botMessageOf("daily_reward_ready", {}, () => null)?.button).toBeNull();
  });

  it("кнопка «Не напоминать»: данные не длиннее 64 байт", () => {
    expect(REMINDER_OFF_DATA).toBe("rm:off");
    expect(REMINDER_OFF_ACTION).toEqual({ text: "🔕 Не напоминать", data: "rm:off" });
    expect(Buffer.byteLength(REMINDER_OFF_ACTION.data)).toBeLessThanOrEqual(64);
  });

  it("`n-<вид>` проходит разбор стартового параметра как уведомление", () => {
    for (const kind of REMINDER_KINDS) {
      expect(parseStartParam(`n-${kind}`)).toMatchObject({ kind: "notification", ref: kind });
      expect(NOTIFICATION_KINDS).toHaveProperty(kind);
    }
  });

  it("названия сложностей совпадают со словарём оболочки", () => {
    const dictionary: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/app-shell/src/i18n/ru.json", import.meta.url)), "utf8"));
    const entries = dictionary as Record<string, string>;
    for (const [id, name] of Object.entries(DIFFICULTY_NAMES)) expect(entries[`difficulty.${id}.name`], id).toBe(name);
    expect(Object.keys(DIFFICULTY_NAMES).sort()).toEqual(["easy", "hard", "normal"]);
  });

  it("настройка игры: название и описание — в словаре оболочки, обращение на «ты»", () => {
    const entries = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/app-shell/src/i18n/ru-bot.json", import.meta.url)), "utf8")) as Record<string, string>;
    expect(entries["settings.bot.reminders"]).toBe("Напоминания");
    expect(entries["settings.bot.reminders.hint"]).toBe("Сообщение от бота не чаще раза в сутки: тебя обогнали в сезоне, сезон скоро закрывается или ждёт награда дня.");
  });
});

describe("кнопка действия в порту и Telegram", () => {
  const BUTTON = { text: "▶ Открыть игру", url: "https://t.me/rubezh_bot/play?startapp=n-daily_reward_ready" };

  function api(error: Error | null = null): { api: MessengerBotApi; calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      api: {
        sendMessage: async (...args: unknown[]) => {
          calls.push(args);
          if (error !== null) throw error;
          return 1;
        },
      },
    };
  }

  it("действие — второй строкой разметки с callback_data под ссылкой", async () => {
    const { api: bot, calls } = api();
    const message: OutgoingMessage = { text: "Награда ждёт", button: BUTTON, action: { text: "🔕 Не напоминать", data: "rm:off" } };
    expect(await new TelegramMessenger(bot, true).send("123456", message)).toEqual({ status: "sent" });
    expect(calls[0]?.[3]).toEqual({ keyboard: [[BUTTON], [{ text: "🔕 Не напоминать", callback_data: "rm:off" }]] });
  });

  it("без действия разметка прежняя: рассылки и прежние уведомления не меняются", async () => {
    const { api: bot, calls } = api();
    await new TelegramMessenger(bot, true).send("123456", { text: "Рассылка", button: BUTTON });
    expect(calls[0]?.[3]).toEqual({ keyboard: [[BUTTON]] });
    const bare = api();
    await new TelegramMessenger(bare.api, true).send("123456", { text: "Без кнопок", button: null });
    expect(bare.calls[0]?.[3]).toEqual({});
  });

  it("нет ссылки на игру — действие остаётся единственной строкой", async () => {
    const { api: bot, calls } = api();
    await new TelegramMessenger(bot, true).send("123456", { text: "Награда ждёт", button: null, action: { text: "🔕 Не напоминать", data: "rm:off" } });
    expect(calls[0]?.[3]).toEqual({ keyboard: [[{ text: "🔕 Не напоминать", callback_data: "rm:off" }]] });
  });

  it("данные действия длиннее 64 байт — сообщение не уходит: без выхода напоминание слать нельзя", async () => {
    const { api: bot, calls } = api();
    const message: OutgoingMessage = { text: "Награда ждёт", button: BUTTON, action: { text: "x", data: "я".repeat(33) } };
    expect(await new TelegramMessenger(bot, true).send("123456", message)).toEqual({ status: "failed", reason: "bad_action" });
    expect(calls).toEqual([]);
  });

  it("сообщение в чат команды: с темой, исходы те же", async () => {
    const target: ChatTarget = { chatId: "-1001234567890", threadId: 57 };
    const { api: bot, calls } = api();
    expect(await new TelegramMessenger(bot, true).sendToChat(target, "Отчёт")).toEqual({ status: "sent" });
    expect(calls[0]?.slice(0, 2)).toEqual([target, "Отчёт"]);
    const gone = api(new TelegramApiError("sendMessage", 400, "Bad Request: chat not found", null));
    expect(await new TelegramMessenger(gone.api, true).sendToChat(target, "Отчёт")).toEqual({ status: "blocked" });
    const busy = api(new TelegramApiError("sendMessage", 429, "Too Many Requests", 7));
    expect(await new TelegramMessenger(busy.api, true).sendToChat(target, "Отчёт")).toEqual({ status: "retry", afterSec: 7 });
  });
});

describe("команда «Не напоминать»", () => {
  const OFF_REPLY = "Напоминания выключены. Включить их снова можно в настройках игры.";

  async function bot() {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling" } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const known = await accounts.upsert({ platform: "telegram", platformUserId: "800001", displayName: "Путник", username: null, photoUrl: null }, Date.now());
    const merges: { accountId: string; input: unknown }[] = [];
    const answers: { id: string; text: string | undefined }[] = [];
    const api: RemindersOffBotApi = {
      async answerCallbackQuery(id, text) {
        answers.push({ id, text });
      },
    };
    const settings = {
      merge: async (account: { accountId: string }, input: unknown) => {
        merges.push({ accountId: account.accountId, input });
        return { version: ACCOUNT_SETTINGS_VERSION, values: {}, ignored: [] };
      },
    };
    const router = new BotRouter();
    new RemindersOffCommand(config, router, api, accounts, settings).onModuleInit();
    return { router, merges, answers, known };
  }

  const press = (data: string | undefined, fromId: number, id = "q1"): TelegramUpdate => ({
    update_id: 1,
    callback_query: { id, from: { id: fromId, is_bot: false, first_name: "Путник" }, ...(data === undefined ? {} : { data }), message: { message_id: 5, chat: { id: fromId, type: "private" } } },
  });

  it("ставит bot.reminders = false аккаунту нажавшего и отвечает", async () => {
    const { router, merges, answers, known } = await bot();
    expect(await router.dispatch(press("rm:off", 800001))).toEqual({ status: "handled", handler: "reminders-off" });
    expect(merges).toEqual([{ accountId: known.accountId, input: { version: ACCOUNT_SETTINGS_VERSION, values: { "bot.reminders": { value: false, ageMs: 0 } } } }]);
    expect(answers).toEqual([{ id: "q1", text: OFF_REPLY }]);
  });

  it("повторное нажатие безвредно: тот же ответ", async () => {
    const { router, merges, answers } = await bot();
    await router.dispatch(press("rm:off", 800001, "q1"));
    await router.dispatch(press("rm:off", 800001, "q2"));
    expect(answers.map((answer) => answer.text)).toEqual([OFF_REPLY, OFF_REPLY]);
    expect(merges).toHaveLength(2);
    expect(merges[1]).toEqual(merges[0]);
  });

  it("неизвестный игрок: тот же ответ, без записи", async () => {
    const { router, merges, answers } = await bot();
    expect(await router.dispatch(press("rm:off", 999999))).toEqual({ status: "handled", handler: "reminders-off" });
    expect(merges).toEqual([]);
    expect(answers).toEqual([{ id: "q1", text: OFF_REPLY }]);
  });

  it("чужой формат данных кнопки и обычные сообщения — игнор: команду берёт кто-то другой", async () => {
    const { router, merges, answers } = await bot();
    for (const data of ["rm:on", "rm:off:1", "rm:", "role:ok:Ab12Cd34Ef56Gh78Ij90Kl", "RM:OFF", " rm:off", undefined]) {
      expect(await router.dispatch(press(data, 800001)), String(data)).toEqual({ status: "unhandled" });
    }
    expect(await router.dispatch({ update_id: 2, message: { message_id: 1, date: 1, text: "rm:off", chat: { id: 800001, type: "private" }, from: { id: 800001, is_bot: false, first_name: "П" } } })).toEqual({ status: "unhandled" });
    expect(merges).toEqual([]);
    expect(answers).toEqual([]);
  });

  it("чтение обновлений выключено — команда не регистрируется", async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "off" } as NodeJS.ProcessEnv);
    const router = new BotRouter();
    const answers: string[] = [];
    new RemindersOffCommand(config, router, { answerCallbackQuery: async (id) => void answers.push(id) }, new MemoryAccountRepository(), { merge: async () => ({ version: 1, values: {}, ignored: [] }) }).onModuleInit();
    expect(await router.dispatch(press("rm:off", 800001))).toEqual({ status: "unhandled" });
    expect(answers).toEqual([]);
  });
});

// --- Планировщик и отчёт на памяти ------------------------------------------------

const SEASON = seasonOf(MSK(4, 12));
const player = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Redis в объёме, который нужен хранилищу напоминаний: `SET NX/PX/EX`, `GET`, `DEL`, снятие лока скриптом и конвейер `EXISTS`. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, { unit: "EX" | "PX"; value: number }>();

  async set(key: string, value: string, ...options: (string | number)[]): Promise<"OK" | null> {
    if (options.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    for (const unit of ["EX", "PX"] as const) {
      const at = options.indexOf(unit);
      if (at >= 0) this.ttls.set(key, { unit, value: Number(options[at + 1]) });
    }
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.values.delete(key)).length;
  }

  async eval(_script: string, _count: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }

  pipeline() {
    const asked: string[] = [];
    const pipe = {
      exists: (key: string) => {
        asked.push(key);
        return pipe;
      },
      exec: async (): Promise<[Error | null, number][]> => asked.map((key) => [null, this.values.has(key) ? 1 : 0]),
    };
    return pipe;
  }
}

class FakeBoard {
  readonly scores = new Map<string, number>();

  private order(): string[] {
    return [...this.scores.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? 1 : -1)).map(([id]) => id);
  }

  async top(_season: string, _difficulty: string, limit: number): Promise<{ accountId: string; survivalSec: number }[]> {
    return this.order()
      .slice(0, limit)
      .map((accountId) => ({ accountId, survivalSec: this.scores.get(accountId) ?? 0 }));
  }

  async rank(_season: string, _difficulty: string, accountId: string): Promise<number | null> {
    const index = this.order().indexOf(accountId);
    return index < 0 ? null : index + 1;
  }

  async scoresOf(_season: string, _difficulty: string, accountIds: readonly string[]): Promise<Map<string, number>> {
    return new Map(accountIds.filter((id) => this.scores.has(id)).map((id) => [id, this.scores.get(id) ?? 0]));
  }
}

class FakeRepository implements RemindersRepository {
  readonly daily: ReminderTarget[] = [];
  readonly closing: ReminderTarget[] = [];
  readonly reachableIds = new Set<string>();
  summary: DaySummary = { sent: { season_overtaken: 0, season_closing: 0, daily_reward_ready: 0 }, undelivered: 0, blockedAfter: 0 };
  summaryWindows: { from: Date; to: Date }[] = [];

  private page(source: ReminderTarget[], after: string | null, limit: number): ReminderTarget[] {
    return source.filter((target) => after === null || target.accountId > after).slice(0, limit);
  }

  async reachable(accountIds: readonly string[]): Promise<ReminderTarget[]> {
    return accountIds.filter((id) => this.reachableIds.has(id)).map((accountId) => ({ accountId, platform: "telegram" as const }));
  }

  async closingPage(_window: { from: Date; to: Date }, after: string | null, limit: number): Promise<ReminderTarget[]> {
    return this.page(this.closing, after, limit);
  }

  async dailyPage(_query: { today: string; lapseDays: number }, after: string | null, limit: number): Promise<ReminderTarget[]> {
    return this.page(this.daily, after, limit);
  }

  async daySummary(window: { from: Date; to: Date }): Promise<DaySummary> {
    this.summaryWindows.push(window);
    return this.summary;
  }
}

class FakeMessenger implements Messenger {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly ratePerSec = 25;
  readonly chatPosts: { target: ChatTarget; text: string }[] = [];
  chatOutcome: SendOutcome = { status: "sent" };

  async send(): Promise<SendOutcome> {
    return { status: "sent" };
  }

  async sendToChat(target: ChatTarget, text: string): Promise<SendOutcome> {
    this.chatPosts.push({ target, text });
    return this.chatOutcome;
  }
}

function scanning(panel: Record<string, string | number | boolean> = {}) {
  const settings = panelSettings({ "reminders.enabled": true, "seasons.start-date": 20_261_026, ...panel });
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
  const redis = new FakeRedis();
  const store = new RemindersStore(redis as unknown as Redis);
  const repository = new FakeRepository();
  const board = new FakeBoard();
  const feed = memoryNotifications();
  const optedOut = new Set<string>();
  const accountSettings = { valueOf: async (accountId: string, key: string) => (key === "bot.reminders" && optedOut.has(accountId) ? false : undefined) };
  const messenger = new FakeMessenger();
  const reports: Date[] = [];
  const report = {
    runIfDue: async (at: Date) => {
      reports.push(at);
      return "not_due" as const;
    },
  };
  const boardStore = {
    top: board.top.bind(board),
    rank: board.rank.bind(board),
    scores: board.scoresOf.bind(board),
  } as unknown as Pick<SeasonBoardStore, "top" | "rank" | "scores">;
  const scanner = (): RemindersScanner =>
    new RemindersScanner(config, settings, repository, store, new SeasonSchedule(settings), boardStore, feed.service, accountSettings, new Messengers([messenger]), report);
  return { settings, redis, store, repository, board, feed, optedOut, messenger, reports, scanner };
}

const rowsOf = (s: ReturnType<typeof scanning>, kind?: ReminderKind) => s.feed.repository.rows.filter((row) => kind === undefined || row.kind === kind);
const target = (n: number) => ({ accountId: player(n), platform: "telegram" as const });

describe("планировщик напоминаний", () => {
  it("выключен ключом — ничего не делает: ни лока, ни строк, ни запросов к базе", async () => {
    const s = scanning({ "reminders.enabled": false });
    s.repository.daily.push(target(1));
    const summary = await s.scanner().tick(MSK(4, 12));
    expect(summary.status).toBe("disabled");
    expect(s.redis.values.size).toBe(0);
    expect(rowsOf(s)).toEqual([]);
  });

  it("тихий час — снимок таблицы не обновляется, строк нет, отчёт всё равно проверяется", async () => {
    const s = scanning();
    s.board.scores.set(player(1), 100);
    s.repository.daily.push(target(2));
    const summary = await s.scanner().tick(MSK(4, 23, 30));
    expect(summary.status).toBe("quiet");
    expect([...s.redis.values.keys()].some((key) => key.startsWith("reminders:snap:"))).toBe(false);
    expect(rowsOf(s)).toEqual([]);
    expect(s.reports).toHaveLength(1);
  });

  it("сезона нет — тик ничего не делает (ключ старта не задан)", async () => {
    const s = scanning({ "seasons.start-date": 0 });
    s.repository.daily.push(target(1));
    expect((await s.scanner().tick(MSK(4, 12))).status).toBe("no_season");
    expect(rowsOf(s)).toEqual([]);
  });

  it("награда дня: строка ленты с ключом игровых суток, повторный тик ничего не добавляет", async () => {
    const s = scanning();
    s.repository.daily.push(target(1), target(2));
    const first = await s.scanner().tick(MSK(4, 12));
    expect(first.created.daily_reward_ready).toBe(2);
    expect(rowsOf(s, "daily_reward_ready").map((row) => [row.accountId, row.dedupeKey, row.payload])).toEqual([
      [player(1), "daily_reward_ready:2026-11-04", {}],
      [player(2), "daily_reward_ready:2026-11-04", {}],
    ]);
    const second = await s.scanner().tick(MSK(4, 12, 10));
    expect(second.created.daily_reward_ready).toBe(0);
    expect(rowsOf(s)).toHaveLength(2);
    expect(s.redis.ttls.get("reminders:cur:daily:2026-11-04")).toEqual({ unit: "EX", value: 2 * 86_400 });
  });

  it("не пишем: окно потолка занято, отписался, у площадки нет бота", async () => {
    const s = scanning();
    s.repository.daily.push(target(1), target(2), target(3), { accountId: player(4), platform: "vk" });
    s.redis.values.set(`bot-notify:${player(1)}:reminder`, randomUUID());
    s.optedOut.add(player(2));
    await s.scanner().tick(MSK(4, 12));
    expect(rowsOf(s).map((row) => row.accountId)).toEqual([player(3)]);
  });

  it("обогнали важнее награды дня: игрок получает одну строку, не две", async () => {
    const s = scanning();
    s.board.scores.set(player(10), 120);
    s.board.scores.set(player(11), 110);
    s.repository.reachableIds.add(player(11));
    await s.scanner().tick(MSK(4, 12));
    expect(rowsOf(s)).toEqual([]);

    s.board.scores.set(player(12), 115);
    s.repository.daily.push(target(11));
    const summary = await s.scanner().tick(MSK(4, 12, 10));
    expect(summary.created.season_overtaken).toBe(1);
    expect(summary.created.daily_reward_ready).toBe(0);
    expect(rowsOf(s).map((row) => [row.accountId, row.kind, row.payload, row.dedupeKey])).toEqual([
      [player(11), "season_overtaken", { difficulty: "hard", place: 3 }, `season_overtaken:${SEASON.key}:2026-11-04`],
    ]);
  });

  it("второй обгон в те же игровые сутки новой строки не создаёт", async () => {
    const s = scanning();
    s.board.scores.set(player(10), 120);
    s.board.scores.set(player(11), 110);
    s.repository.reachableIds.add(player(11));
    await s.scanner().tick(MSK(4, 12));
    s.board.scores.set(player(12), 115);
    await s.scanner().tick(MSK(4, 12, 10));
    s.board.scores.set(player(13), 118);
    await s.scanner().tick(MSK(4, 12, 20));
    expect(rowsOf(s, "season_overtaken")).toHaveLength(1);
  });

  it("сезон закрывается: только в игровой день перед закрытием и только игрокам с рейтинговым забегом недели", async () => {
    const s = scanning();
    s.repository.closing.push(target(1), target(2));
    expect((await s.scanner().tick(MSK(7, 12))).created.season_closing).toBe(0);
    const day = await s.scanner().tick(MSK(8, 12));
    expect(day.created.season_closing).toBe(2);
    expect(rowsOf(s, "season_closing").map((row) => [row.dedupeKey, row.payload])).toEqual([
      [`season_closing:${SEASON.key}`, { endsAt: SEASON.endsAt.toISOString() }],
      [`season_closing:${SEASON.key}`, { endsAt: SEASON.endsAt.toISOString() }],
    ]);
    expect((await s.scanner().tick(MSK(9, 12))).created.season_closing).toBe(0);
  });

  it("сезон закрывается важнее награды дня", async () => {
    const s = scanning();
    s.repository.closing.push(target(1));
    s.repository.daily.push(target(1), target(2));
    await s.scanner().tick(MSK(8, 12));
    expect(rowsOf(s).map((row) => [row.accountId, row.kind])).toEqual([
      [player(1), "season_closing"],
      [player(2), "daily_reward_ready"],
    ]);
  });

  it("два планировщика разом: работу делает один, второй отпускается с «занято»", async () => {
    const s = scanning();
    s.repository.daily.push(target(1), target(2), target(3));
    const [left, right] = await Promise.all([s.scanner().tick(MSK(4, 12)), s.scanner().tick(MSK(4, 12))]);
    expect([left.status, right.status].sort()).toEqual(["done", "locked"]);
    expect(rowsOf(s)).toHaveLength(3);
    expect(s.redis.values.has("reminders:scan:lock")).toBe(false);
  });

  it("сбой посреди тика отпускает лок и не двигает курсор: следующий тик начнёт с того же места", async () => {
    const s = scanning();
    s.repository.daily.push(target(1));
    let broken = true;
    const real = s.repository.dailyPage.bind(s.repository);
    s.repository.dailyPage = async (...args) => {
      if (broken) throw new Error("база недоступна");
      return await real(...args);
    };
    const failed = await s.scanner().tick(MSK(4, 12));
    expect(failed.status).toBe("failed");
    expect(s.redis.values.has("reminders:scan:lock")).toBe(false);
    expect(s.redis.values.has("reminders:cur:daily:2026-11-04")).toBe(false);
    broken = false;
    expect((await s.scanner().tick(MSK(4, 12, 10))).created.daily_reward_ready).toBe(1);
  });

  it("у 1 200 игроков курсор проходит всех ровно по разу за три тика", async () => {
    const s = scanning();
    for (let n = 1; n <= 1_200; n++) s.repository.daily.push(target(n));
    const created: number[] = [];
    for (let tick = 0; tick < 4; tick++) created.push((await s.scanner().tick(MSK(4, 12, tick * 10))).created.daily_reward_ready);
    expect(created).toEqual([500, 500, 200, 0]);
    expect(new Set(rowsOf(s).map((row) => row.accountId)).size).toBe(1_200);
  });
});

describe("суточный отчёт команде", () => {
  const CHAT: ChatTarget = { chatId: "-1001234567890", threadId: 57 };

  function reporting(panel: Record<string, string | number | boolean> = { "reminders.enabled": true, "notify.chat.reminders": "-1001234567890:57" }) {
    const s = scanning(panel);
    s.repository.summary = { sent: { season_overtaken: 12, season_closing: 3, daily_reward_ready: 40 }, undelivered: 4, blockedAfter: 2 };
    const targets = { chats: () => ({ general: null }) };
    const report = new RemindersReport(s.settings, targets as never, s.store, s.repository, new Messengers([s.messenger]));
    return { s, report };
  }

  it("текст: по видам, не доставлено, заблокировали бота и доля от отправленных", () => {
    expect(reportText("2026-11-03", { sent: { season_overtaken: 12, season_closing: 3, daily_reward_ready: 40 }, undelivered: 4, blockedAfter: 2 })).toBe(
      ["🔔 Напоминания за 3 ноября", "Обогнали в сезоне: отправлено 12", "Сезон закрывается: отправлено 3", "Награда дня: отправлено 40", "Не доставлено: 4 · бота заблокировали: 2 (3,6% от отправленных)"].join("\n"),
    );
    expect(reportText("2026-11-03", { sent: { season_overtaken: 0, season_closing: 0, daily_reward_ready: 0 }, undelivered: 0, blockedAfter: 0 })).toContain("бота заблокировали: 0 (0% от отправленных)");
  });

  it("раз в сутки: первый тик после 00:10 по Москве шлёт отчёт за вчера, остальные — нет", async () => {
    const { s, report } = reporting();
    expect(await report.runIfDue(MSK(4, 0, 9))).toBe("not_due");
    expect(s.messenger.chatPosts).toEqual([]);
    expect(await report.runIfDue(MSK(4, 0, 10))).toBe("sent");
    expect(s.messenger.chatPosts).toHaveLength(1);
    expect(s.messenger.chatPosts[0]?.target).toEqual(CHAT);
    expect(s.messenger.chatPosts[0]?.text.startsWith("🔔 Напоминания за 3 ноября")).toBe(true);
    expect(await report.runIfDue(MSK(4, 0, 20))).toBe("already");
    expect(await report.runIfDue(MSK(4, 15, 0))).toBe("already");
    expect(s.messenger.chatPosts).toHaveLength(1);
    expect(s.repository.summaryWindows[0]).toEqual({ from: new Date(Date.UTC(2026, 10, 2, 21)), to: new Date(Date.UTC(2026, 10, 3, 21)) });
  });

  it("две реплики: отчёт уходит один раз", async () => {
    const { s, report } = reporting();
    const other = new RemindersReport(s.settings, { chats: () => ({ general: null }) } as never, s.store, s.repository, new Messengers([s.messenger]));
    const results = await Promise.all([report.runIfDue(MSK(4, 1)), other.runIfDue(MSK(4, 1))]);
    expect(results.sort()).toEqual(["already", "sent"]);
    expect(s.messenger.chatPosts).toHaveLength(1);
  });

  it("поток не задан — общий чат; ни того ни другого — в чат ничего не уходит", async () => {
    const withGeneral = reporting({ "reminders.enabled": true });
    const general: ChatTarget = { chatId: "-100999", threadId: null };
    const report = new RemindersReport(withGeneral.s.settings, { chats: () => ({ general }) } as never, withGeneral.s.store, withGeneral.s.repository, new Messengers([withGeneral.s.messenger]));
    expect(await report.runIfDue(MSK(4, 1))).toBe("sent");
    expect(withGeneral.s.messenger.chatPosts[0]?.target).toEqual(general);

    const none = reporting({ "reminders.enabled": true });
    expect(await none.report.runIfDue(MSK(4, 1))).toBe("no_chat");
    expect(none.s.messenger.chatPosts).toEqual([]);
  });

  it("напоминания выключены — отчёта нет", async () => {
    const { s, report } = reporting({ "reminders.enabled": false, "notify.chat.reminders": "-1001234567890" });
    expect(await report.runIfDue(MSK(4, 1))).toBe("disabled");
    expect(s.messenger.chatPosts).toEqual([]);
  });

  it("площадка просит подождать — отметка снимается, следующий тик повторит; отказ — отметка остаётся", async () => {
    const { s, report } = reporting();
    s.messenger.chatOutcome = { status: "retry", afterSec: 5 };
    expect(await report.runIfDue(MSK(4, 1))).toBe("failed");
    s.messenger.chatOutcome = { status: "sent" };
    expect(await report.runIfDue(MSK(4, 1, 10))).toBe("sent");

    const refused = reporting();
    refused.s.messenger.chatOutcome = { status: "failed", reason: "400" };
    expect(await refused.report.runIfDue(MSK(4, 1))).toBe("failed");
    refused.s.messenger.chatOutcome = { status: "sent" };
    expect(await refused.report.runIfDue(MSK(4, 1, 10))).toBe("already");
  });

  it("сбой чтения цифр отпускает отметку: отчёт не теряется", async () => {
    const { s, report } = reporting();
    const real = s.repository.daySummary.bind(s.repository);
    s.repository.daySummary = async () => {
      throw new Error("база недоступна");
    };
    expect(await report.runIfDue(MSK(4, 1))).toBe("failed");
    s.repository.daySummary = real;
    expect(await report.runIfDue(MSK(4, 1, 10))).toBe("sent");
  });
});

describe("ключи каталога настроек напоминаний", () => {
  it("включатель выключен по умолчанию, остальные ключи — со стартовыми значениями из спецификации", () => {
    expect(SETTINGS.remindersEnabled.key).toBe("reminders.enabled");
    expect(SETTINGS.remindersEnabled.fallback).toBe(false);
    expect([SETTINGS.remindersMinGapHours, SETTINGS.remindersQuietFromHour, SETTINGS.remindersQuietToHour, SETTINGS.remindersLapseDays].map((setting) => [setting.key, setting.fallback])).toEqual([
      ["reminders.min-gap-hours", 24],
      ["reminders.quiet-from-hour", 21],
      ["reminders.quiet-to-hour", 10],
      ["reminders.lapse-days", 14],
    ]);
    expect([SETTINGS.remindersMinGapHours, SETTINGS.remindersQuietFromHour, SETTINGS.remindersQuietToHour, SETTINGS.remindersLapseDays].map((setting) => [setting.range?.min, setting.range?.max])).toEqual([
      [12, 168],
      [0, 23],
      [0, 23],
      [1, 60],
    ]);
    expect(SETTINGS.chatReminders.key).toBe("notify.chat.reminders");
    expect(SETTINGS.chatReminders.fallback).toBe("");
  });
});
