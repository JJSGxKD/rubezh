import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessagingReason, MessagingState } from "../src/modules/messaging/messaging.repository.js";
import type { BotOutcome } from "../src/modules/notifications/notifications.repository.js";
import { BotNotifyQueue } from "../src/modules/notifications-bot/bot-notify-queue.js";
import { botRuleOf } from "../src/modules/notifications-bot/bot-notify-rules.js";
import { BotNotifySender, type BotDelivery, type BotNotifyJob } from "../src/modules/notifications-bot/bot-notify-sender.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Дубль уведомлений в бота (docs/35-stage4-plan.md WP28): критерий приёмки —
 * игрок, который запретил сообщения в бота, их не получает. Запрет бывает
 * двух видов — площадки (заблокировал бота, не начинал разговор) и свой
 * (выключил вид в настройках), — и оба закрепляются здесь, вместе с потолком
 * вида и исходами отправки.
 */

const NOW = new Date(Date.UTC(2026, 8, 30, 9));

class FakeMessenger implements Messenger {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly ratePerSec = 25;
  readonly sent: { to: string; message: OutgoingMessage }[] = [];
  next: SendOutcome = { status: "sent" };

  async send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome> {
    this.sent.push({ to: platformUserId, message });
    return this.next;
  }
}

/** Redis для окна вида: `SET NX EX` и `GET`, срок не нужен — тест укладывается в окно. */
class FakeRedis {
  readonly keys = new Map<string, string>();
  readonly windows = new Map<string, number>();

  async set(key: string, value: string, ...options: (string | number)[]): Promise<"OK" | null> {
    if (options.includes("NX") && this.keys.has(key)) return null;
    this.keys.set(key, value);
    const seconds = options[options.indexOf("EX") + 1];
    if (typeof seconds === "number") this.windows.set(key, seconds);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.keys.get(key) ?? null;
  }
}

function setup(panelValues: Record<string, SettingValue> = {}) {
  const panel = panelSettings(panelValues);
  const accounts = new MemoryAccountRepository();
  const messenger = new FakeMessenger();
  const redis = new FakeRedis();
  const states = new Map<string, MessagingState>();
  const settings = new Map<string, boolean>();
  const changes: { platformUserId: string; reason: MessagingReason }[] = [];
  const marks: { notificationId: string; outcome: BotOutcome }[] = [];

  const links = new AppLinks([{ platform: "telegram", launch: (param) => `https://t.me/rubezh_bot/play?startapp=${param}`, chat: () => null }]);
  const messaging = {
    state: async (accountId: string) => states.get(accountId) ?? null,
    platformChanged: async (_platform: string, platformUserId: string, reason: MessagingReason) => {
      changes.push({ platformUserId, reason });
    },
  };
  const accountSettings = { valueOf: async (_accountId: string, key: string) => settings.get(key) };
  const notifications = {
    markBot: async (notificationId: string, outcome: BotOutcome) => {
      marks.push({ notificationId, outcome });
    },
  };
  const sender = new BotNotifySender(accounts, new Messengers([messenger]), links, messaging, accountSettings, notifications, redis as unknown as Redis, panel);
  return { accounts, messenger, redis, states, settings, changes, marks, sender, panel };
}

let nextUserId = 700_000;

async function player(s: ReturnType<typeof setup>, canMessage: boolean | null = true) {
  nextUserId++;
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: String(nextUserId), displayName: "Путник", username: null, photoUrl: null }, NOW.getTime());
  if (canMessage !== null) s.states.set(account.accountId, { canMessage, reason: canMessage ? "entered" : "blocked", changedAt: NOW });
  return account;
}

function request(accountId: string, fromName = "Дым"): BotNotifyJob {
  return { notificationId: randomUUID(), accountId, kind: "friend_request", payload: { fromAccountId: randomUUID(), fromName } };
}

describe("дубль уведомлений в бота", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  it("заявка в друзья уходит текстом с именем и кнопкой в игру с параметром вида", async () => {
    const target = await player(s);
    const job = request(target.accountId);

    expect(await s.sender.deliver(job, NOW)).toEqual({ status: "sent" });
    expect(s.messenger.sent).toEqual([
      {
        to: target.platformUserId,
        message: { text: "Дым зовёт тебя в друзья в «Рубеже». Принять заявку можно в разделе «Друзья».", button: { text: "▶ Открыть игру", url: "https://t.me/rubezh_bot/play?startapp=n-friend_request" } },
      },
    ]);
    expect(s.marks).toEqual([{ notificationId: job.notificationId, outcome: "sent" }]);
  });

  it("писать нельзя — заблокировал бота или не начинал разговор — не пишем вовсе", async () => {
    const blocked = await player(s, false);
    const stranger = await player(s, null);

    expect(await s.sender.deliver(request(blocked.accountId), NOW)).toEqual({ status: "skipped", reason: "not_allowed" });
    expect(await s.sender.deliver(request(stranger.accountId), NOW)).toEqual({ status: "skipped", reason: "not_allowed" });
    expect(s.messenger.sent).toEqual([]);
    expect(s.marks).toEqual([]);
  });

  it("свой выбор игрока сильнее умолчания: подарок выключен, пока не включат, а выключенная заявка не уходит", async () => {
    const target = await player(s);
    const gift: BotNotifyJob = { notificationId: randomUUID(), accountId: target.accountId, kind: "friend_gift", payload: { fromAccountId: randomUUID(), fromName: "Дым" } };

    expect(await s.sender.deliver(gift, NOW)).toEqual({ status: "skipped", reason: "opted_out" });
    s.settings.set("bot.friendGift", true);
    expect(await s.sender.deliver(gift, NOW)).toEqual({ status: "sent" });
    expect(s.messenger.sent[0]?.message.text).toBe("Дым дарит тебе подарок в «Рубеже» — забери его в разделе «Друзья».");

    s.settings.set("bot.friendRequest", false);
    expect(await s.sender.deliver(request(target.accountId), NOW)).toEqual({ status: "skipped", reason: "opted_out" });
    expect(s.messenger.sent).toHaveLength(1);
  });

  it("потолок вида: вторая заявка за час ждёт в ленте, повтор того же задания проходит, сообщение команды — без потолка", async () => {
    const target = await player(s);
    const first = request(target.accountId);

    expect(await s.sender.deliver(first, NOW)).toEqual({ status: "sent" });
    expect(await s.sender.deliver(request(target.accountId, "Искра"), NOW)).toEqual({ status: "skipped", reason: "throttled" });
    expect(await s.sender.deliver(first, NOW)).toEqual({ status: "sent" });

    const team = (text: string): BotNotifyJob => ({ notificationId: randomUUID(), accountId: target.accountId, kind: "team_message", payload: { text } });
    expect(await s.sender.deliver(team("Первое"), NOW)).toEqual({ status: "sent" });
    expect(await s.sender.deliver(team("Второе"), NOW)).toEqual({ status: "sent" });
    expect(s.messenger.sent.at(-1)?.message.text).toBe("Сообщение команды «Рубежа»:\n\nВторое");
  });

  it("блокировка при отправке — отметка у игрока и исход в строке ленты", async () => {
    const target = await player(s);
    s.messenger.next = { status: "blocked" };
    const job = request(target.accountId);

    expect(await s.sender.deliver(job, NOW)).toEqual({ status: "blocked" });
    expect(s.changes).toEqual([{ platformUserId: target.platformUserId, reason: "blocked" }]);
    expect(s.marks).toEqual([{ notificationId: job.notificationId, outcome: "blocked" }]);
  });

  it("площадка просит подождать — исхода нет, его запишет повтор; отказ — «не доставлено»", async () => {
    const target = await player(s);
    s.messenger.next = { status: "retry", afterSec: 7 };
    expect(await s.sender.deliver(request(target.accountId), NOW)).toEqual({ status: "retry", afterSec: 7 });
    expect(s.marks).toEqual([]);

    const other = await player(s);
    s.messenger.next = { status: "failed", reason: "400" };
    const job = request(other.accountId);
    expect(await s.sender.deliver(job, NOW)).toEqual({ status: "failed", reason: "400" });
    expect(s.marks).toEqual([{ notificationId: job.notificationId, outcome: "failed" }]);
  });

  it("выход версии в бота не дублируется: задание пропускается, сообщение не уходит (T-0019)", async () => {
    const target = await player(s);
    const update: BotNotifyJob = { notificationId: randomUUID(), accountId: target.accountId, kind: "app_update", payload: { version: "0.6.0" } };

    expect(botRuleOf("app_update")).toBeUndefined();
    expect(await s.sender.deliver(update, NOW)).toEqual({ status: "skipped", reason: "not_duplicated" });
    expect(s.messenger.sent).toEqual([]);
  });

  it("не пишем: вид не дублируется, аккаунта нет, он заблокирован, данные не по схеме", async () => {
    const target = await player(s);
    const loot: BotNotifyJob = { notificationId: randomUUID(), accountId: target.accountId, kind: "rare_loot", payload: {} };
    expect(await s.sender.deliver(loot, NOW)).toEqual({ status: "skipped", reason: "not_duplicated" });
    expect(await s.sender.deliver(request(randomUUID()), NOW)).toEqual({ status: "skipped", reason: "no_account" });
    expect(await s.sender.deliver({ ...request(target.accountId), payload: { fromName: "" } }, NOW)).toEqual({ status: "skipped", reason: "bad_payload" });

    await s.accounts.setBan(target.accountId, { at: NOW, reason: "накрутка" });
    expect(await s.sender.deliver(request(target.accountId), NOW)).toEqual({ status: "skipped", reason: "banned" });
    expect(s.messenger.sent).toEqual([]);
  });

  it("у площадки нет бота — не пишем", async () => {
    const target = await player(s);
    const sender = new BotNotifySender(
      s.accounts,
      new Messengers([]),
      new AppLinks([]),
      { state: async () => ({ canMessage: true, reason: "entered", changedAt: NOW }), platformChanged: async () => {} },
      { valueOf: async () => undefined },
      { markBot: async () => {} },
      s.redis as unknown as Redis,
      s.panel,
    );
    expect(await sender.deliver(request(target.accountId), NOW)).toEqual({ status: "skipped", reason: "no_bot" });
  });
});

// Напоминания (tasks/T-0128): три вида под одним ключом игрока, одним окном
// потолка и общими правилами тихих часов и включателя.
describe("напоминания в дубле бота", () => {
  /** 12:00 по Москве — не тихо; 22:30 по Москве — тихо при умолчании 21 → 10. */
  const DAY = new Date(Date.UTC(2026, 10, 4, 9, 0));
  const NIGHT = new Date(Date.UTC(2026, 10, 4, 19, 30));
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup({ "reminders.enabled": true });
  });

  const reminder = (accountId: string, kind = "daily_reward_ready", payload: unknown = {}): BotNotifyJob => ({ notificationId: randomUUID(), accountId, kind, payload });
  const overtaken = (accountId: string): BotNotifyJob => reminder(accountId, "season_overtaken", { difficulty: "hard", place: 4 });
  const closing = (accountId: string): BotNotifyJob => reminder(accountId, "season_closing", { endsAt: "2026-11-09T00:00:00.000Z" });

  it("у напоминания в сообщении кнопка в игру и кнопка действия «Не напоминать», у заявки в друзья действия нет", async () => {
    const target = await player(s);
    expect(await s.sender.deliver(reminder(target.accountId), DAY)).toEqual({ status: "sent" });
    expect(s.messenger.sent[0]?.message).toEqual({
      text: "Награда дня ждёт тебя в «Рубеже». Загляни и забери её сегодня.",
      button: { text: "▶ Открыть игру", url: "https://t.me/rubezh_bot/play?startapp=n-daily_reward_ready" },
      action: { text: "🔕 Не напоминать", data: "rm:off" },
    });

    const other = await player(s);
    expect(await s.sender.deliver(request(other.accountId), DAY)).toEqual({ status: "sent" });
    expect(s.messenger.sent[1]?.message).not.toHaveProperty("action");
  });

  it("включатель выключен — напоминание не уходит, и это проверяется до всего остального", async () => {
    const off = setup();
    const target = await player(off);
    expect(await off.sender.deliver(reminder(target.accountId), DAY)).toEqual({ status: "skipped", reason: "disabled" });
    expect(await off.sender.deliver(overtaken(target.accountId), DAY)).toEqual({ status: "skipped", reason: "disabled" });
    expect(off.messenger.sent).toEqual([]);
    expect(off.redis.keys.size).toBe(0);

    // Остальные виды включателем напоминаний не управляются.
    expect(await off.sender.deliver(request(target.accountId), DAY)).toEqual({ status: "sent" });
  });

  it("тихие часы: задание не уходит, окно потолка цело — утром то же задание проходит", async () => {
    const target = await player(s);
    const job = reminder(target.accountId);
    expect(await s.sender.deliver(job, NIGHT)).toEqual({ status: "skipped", reason: "quiet_hours" });
    expect(s.redis.keys.size).toBe(0);
    expect(s.messenger.sent).toEqual([]);
    expect(await s.sender.deliver(job, DAY)).toEqual({ status: "sent" });
  });

  it("тихие часы берутся из ключей панели, и окно может не переходить через полночь", async () => {
    const custom = setup({ "reminders.enabled": true, "reminders.quiet-from-hour": 13, "reminders.quiet-to-hour": 15 });
    const target = await player(custom);
    expect(await custom.sender.deliver(reminder(target.accountId), new Date(Date.UTC(2026, 10, 4, 11, 0)))).toEqual({ status: "skipped", reason: "quiet_hours" });
    expect(await custom.sender.deliver(reminder(target.accountId), new Date(Date.UTC(2026, 10, 4, 9, 0)))).toEqual({ status: "sent" });
  });

  it("окно потолка общее на три вида: второе напоминание подряд — throttled, повтор того же задания проходит", async () => {
    const target = await player(s);
    const first = overtaken(target.accountId);
    expect(await s.sender.deliver(first, DAY)).toEqual({ status: "sent" });
    expect(await s.sender.deliver(closing(target.accountId), DAY)).toEqual({ status: "skipped", reason: "throttled" });
    expect(await s.sender.deliver(reminder(target.accountId), DAY)).toEqual({ status: "skipped", reason: "throttled" });
    expect(await s.sender.deliver(first, DAY)).toEqual({ status: "sent" });
    expect(s.redis.keys.has(`bot-notify:${target.accountId}:reminder`)).toBe(true);
    expect(s.messenger.sent).toHaveLength(2);
  });

  it("окно — reminders.min-gap-hours в секундах (по умолчанию 20 часов)", async () => {
    const target = await player(s);
    await s.sender.deliver(reminder(target.accountId), DAY);
    expect(s.redis.windows.get(`bot-notify:${target.accountId}:reminder`)).toBe(72_000);

    const short = setup({ "reminders.enabled": true, "reminders.min-gap-hours": 12 });
    const other = await player(short);
    await short.sender.deliver(reminder(other.accountId), DAY);
    expect(short.redis.windows.get(`bot-notify:${other.accountId}:reminder`)).toBe(43_200);
  });

  it("напоминание не занимает окно заявки и подарка: у них свои потолки", async () => {
    const target = await player(s);
    expect(await s.sender.deliver(reminder(target.accountId), DAY)).toEqual({ status: "sent" });
    expect(await s.sender.deliver(request(target.accountId), DAY)).toEqual({ status: "sent" });
  });

  it("один ключ игрока на три вида: bot.reminders = false — opted_out для каждого", async () => {
    const target = await player(s);
    s.settings.set("bot.reminders", false);
    for (const job of [overtaken(target.accountId), closing(target.accountId), reminder(target.accountId)]) {
      expect(await s.sender.deliver(job, DAY)).toEqual({ status: "skipped", reason: "opted_out" });
    }
    expect(s.messenger.sent).toEqual([]);
    expect(s.redis.keys.size).toBe(0);
  });

  it("игрок не выбирал — напоминания включены по умолчанию", async () => {
    const target = await player(s);
    expect(botRuleOf("daily_reward_ready")).toMatchObject({ setting: "bot.reminders", byDefault: true });
    expect(botRuleOf("season_overtaken")).toMatchObject({ setting: "bot.reminders", byDefault: true });
    expect(botRuleOf("season_closing")).toMatchObject({ setting: "bot.reminders", byDefault: true });
    expect(await s.sender.deliver(reminder(target.accountId), DAY)).toEqual({ status: "sent" });
  });

  it("без разрешения писать, после блокировки бота и у заблокированного аккаунта — не пишем, потолок не расходуется", async () => {
    const stranger = await player(s, null);
    const blocked = await player(s, false);
    expect(await s.sender.deliver(reminder(stranger.accountId), DAY)).toEqual({ status: "skipped", reason: "not_allowed" });
    expect(await s.sender.deliver(reminder(blocked.accountId), DAY)).toEqual({ status: "skipped", reason: "not_allowed" });
    const banned = await player(s);
    await s.accounts.setBan(banned.accountId, { at: DAY, reason: "накрутка" });
    expect(await s.sender.deliver(reminder(banned.accountId), DAY)).toEqual({ status: "skipped", reason: "banned" });
    expect(s.messenger.sent).toEqual([]);
    expect(s.redis.keys.size).toBe(0);
  });

  it("блокировка при отправке напоминания — отметка у игрока и исход в строке ленты", async () => {
    const target = await player(s);
    s.messenger.next = { status: "blocked" };
    const job = reminder(target.accountId);
    expect(await s.sender.deliver(job, DAY)).toEqual({ status: "blocked" });
    expect(s.changes).toEqual([{ platformUserId: target.platformUserId, reason: "blocked" }]);
    expect(s.marks).toEqual([{ notificationId: job.notificationId, outcome: "blocked" }]);
  });

  it("данные не по схеме — писать нечего, окно не занято", async () => {
    const target = await player(s);
    expect(await s.sender.deliver(reminder(target.accountId, "season_overtaken", { difficulty: "hard" }), DAY)).toEqual({ status: "skipped", reason: "bad_payload" });
    expect(s.redis.keys.size).toBe(0);
  });
});

describe("очередь дубля в бота", () => {
  function queueWith(delivery: BotDelivery) {
    const feed = memoryNotifications();
    const sender = { deliver: async () => delivery } as unknown as BotNotifySender;
    const queue = new BotNotifyQueue(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), feed.service, sender);
    queue.onModuleInit();
    return { queue, feed };
  }

  it("площадка просит ждать, а повторы кончились — исход «не доставлено»", async () => {
    const { queue, feed } = queueWith({ status: "retry", afterSec: 5 });
    let id = "";
    feed.service.onCreated("id", async (created) => {
      id = created.notificationId;
    });
    await feed.service.deliver({ accountId: randomUUID(), kind: "team_message", payload: { text: "Привет" }, dedupeKey: "team:q1" });

    await queue.process({ data: { notificationId: id, accountId: randomUUID(), kind: "team_message", payload: { text: "Привет" }, deferrals: 3 } });
    expect(feed.repository.rows[0]?.bot?.outcome).toBe("failed");
  });

  it("задание из Redis не по схеме — ошибка, а не отправка наугад", async () => {
    const { queue } = queueWith({ status: "sent" });
    await expect(queue.process({ data: { notificationId: "не uuid", accountId: randomUUID(), kind: "team_message", payload: {} } })).rejects.toThrow();
  });

  it("без очереди (вход игроков выключен) слушатель ленты молчит, а не падает", async () => {
    const { queue } = queueWith({ status: "sent" });
    await expect(queue.enqueue({ notificationId: randomUUID(), accountId: randomUUID(), kind: "friend_request", payload: {}, at: NOW })).resolves.toBeUndefined();
  });
});
