import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Type } from "@nestjs/common";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotMessageEvents } from "../src/modules/bot-messages/bot-message-events.js";
import { BotMessagePolicy } from "../src/modules/bot-messages/bot-message-policy.js";
import { BotMessagesModule } from "../src/modules/bot-messages/bot-messages.module.js";
import { BotMessages } from "../src/modules/bot-messages/bot-messages.service.js";
import type { MessagingReason, MessagingState } from "../src/modules/messaging/messaging.repository.js";
import type { BotOutcome } from "../src/modules/notifications/notifications.repository.js";
import { BotNotifyQueue } from "../src/modules/notifications-bot/bot-notify-queue.js";
import { BotNotifySender, type BotDelivery, type BotNotifyJob } from "../src/modules/notifications-bot/bot-notify-sender.js";
import { NotificationsBotModule } from "../src/modules/notifications-bot/notifications-bot.module.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Дубль уведомлений под правилами звука и тихих часов (tasks/T-0394, Р199,
 * правило 6): всё, что бот пишет сам, ждёт конца тихих часов, со звуком — не
 * больше двух в игровые сутки; событие `bot_message_sent` пишется всегда.
 */

/** 12:00 по Москве; 23:00 по Москве — тихо при умолчании 21 → 10. */
const DAY = new Date(Date.UTC(2026, 10, 4, 9, 0));
const NIGHT = new Date(Date.UTC(2026, 10, 4, 20, 0));
/** От 23:00 до 10:00 по Москве — 11 часов. */
const UNTIL_MORNING_SEC = 11 * 3_600;

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

/** Redis окна вида (`SET NX EX`, `GET`) и счётчика звука (`eval`). */
class FakeRedis {
  readonly keys = new Map<string, string>();
  readonly counts = new Map<string, number>();

  async set(key: string, value: string, ...options: (string | number)[]): Promise<"OK" | null> {
    if (options.includes("NX") && this.keys.has(key)) return null;
    this.keys.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.keys.get(key) ?? null;
  }

  async eval(_script: string, _keys: number, key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

type SentEvent = Parameters<BotMessageEvents["sent"]>[0];

function setup(panelValues: Record<string, SettingValue> = {}, formats = true) {
  const panel = panelSettings({ "bot.formats.enabled": formats, ...panelValues });
  const accounts = new MemoryAccountRepository();
  const messenger = new FakeMessenger();
  const redis = new FakeRedis();
  const states = new Map<string, MessagingState>();
  const marks: { notificationId: string; outcome: BotOutcome }[] = [];
  const events: SentEvent[] = [];

  const links = new AppLinks([{ platform: "telegram", launch: (param) => `https://t.me/rubezh_bot/play?startapp=${param}`, chat: () => null }]);
  const messaging = {
    state: async (accountId: string) => states.get(accountId) ?? null,
    platformChanged: async (_platform: string, _platformUserId: string, _reason: MessagingReason) => {},
  };
  const notifications = {
    markBot: async (notificationId: string, outcome: BotOutcome) => {
      marks.push({ notificationId, outcome });
    },
  };
  const policy = new BotMessagePolicy(redis as unknown as Redis, panel);
  const recorder = {
    sent: async (event: SentEvent) => {
      events.push(event);
    },
  } as unknown as BotMessageEvents;
  const sender = new BotNotifySender(accounts, new Messengers([messenger]), links, messaging, { valueOf: async () => undefined }, notifications, redis as unknown as Redis, panel, policy, recorder);
  return { accounts, messenger, redis, states, marks, events, sender, panel };
}

let nextUserId = 810_000;

async function player(s: ReturnType<typeof setup>) {
  nextUserId++;
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: String(nextUserId), displayName: "Путник", username: null, photoUrl: null }, DAY.getTime());
  s.states.set(account.accountId, { canMessage: true, reason: "entered", changedAt: DAY });
  return account;
}

const request = (accountId: string): BotNotifyJob => ({ notificationId: randomUUID(), accountId, kind: "friend_request", payload: { fromAccountId: randomUUID(), fromName: "Дым" } });
const team = (accountId: string, text = "Привет"): BotNotifyJob => ({ notificationId: randomUUID(), accountId, kind: "team_message", payload: { text } });

describe("дубль уведомлений: тихие часы и звук", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  it("заявка в друзья в 23:00 по Москве при включённом формате ждёт 10:00: исход deferred, окно вида не занято, события нет", async () => {
    const target = await player(s);
    const delivery = await s.sender.deliver(request(target.accountId), NIGHT);

    expect(delivery).toEqual({ status: "deferred", afterSec: UNTIL_MORNING_SEC });
    expect(s.messenger.sent).toEqual([]);
    expect(s.redis.keys.size).toBe(0);
    expect(s.redis.counts.size).toBe(0);
    expect(s.marks).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("формат выключен — заявка ночью уходит сразу и со звуком, как сейчас", async () => {
    const off = setup({}, false);
    const target = await player(off);
    expect(await off.sender.deliver(request(target.accountId), NIGHT)).toEqual({ status: "sent" });
    expect(off.messenger.sent[0]?.message).not.toHaveProperty("silent");
    expect(off.redis.counts.size).toBe(0);
  });

  it("отложенное задание, которое снова попало в тихие часы, уходит без звука, а не откладывается второй раз", async () => {
    const target = await player(s);
    const job: BotNotifyJob = { ...request(target.accountId), quietDeferred: true };
    expect(await s.sender.deliver(job, NIGHT)).toEqual({ status: "sent" });
    expect(s.messenger.sent[0]?.message.silent).toBe(true);
  });

  it("днём первые два сообщения бота со звуком, третье — без звука", async () => {
    const target = await player(s);
    for (const index of [1, 2, 3]) expect(await s.sender.deliver(team(target.accountId, `Сообщение ${String(index)}`), DAY)).toEqual({ status: "sent" });

    expect(s.messenger.sent.map((entry) => entry.message.silent)).toEqual([undefined, undefined, true]);
  });

  it("потолок звука — ключ панели bot.loud-per-day", async () => {
    const one = setup({ "bot.loud-per-day": 1 });
    const target = await player(one);
    await one.sender.deliver(team(target.accountId, "Первое"), DAY);
    await one.sender.deliver(team(target.accountId, "Второе"), DAY);
    expect(one.messenger.sent.map((entry) => entry.message.silent)).toEqual([undefined, true]);
  });

  it("заявка днём: после отправки событие с видом, форматом text, без темы и со звуком", async () => {
    const target = await player(s);
    expect(await s.sender.deliver(request(target.accountId), DAY)).toEqual({ status: "sent" });
    expect(s.events).toEqual([{ kind: "friend_request", format: "text", outcome: "sent", topic: "none", silent: false, platform: "telegram" }]);
  });

  it("исход события: запасной текст — fallback, блокировка — blocked, отказ — failed; третье сообщение дня — silent", async () => {
    const target = await player(s);
    s.messenger.next = { status: "sent", fallback: true };
    await s.sender.deliver(team(target.accountId, "Один"), DAY);
    s.messenger.next = { status: "blocked" };
    await s.sender.deliver(team(target.accountId, "Два"), DAY);
    s.messenger.next = { status: "failed", reason: "400" };
    await s.sender.deliver(team(target.accountId, "Три"), DAY);

    expect(s.events.map((event) => [event.outcome, event.silent])).toEqual([
      ["fallback", false],
      ["blocked", false],
      ["failed", true],
    ]);
  });

  it("retry события не пишет — его запишет повтор", async () => {
    const target = await player(s);
    s.messenger.next = { status: "retry", afterSec: 5 };
    expect(await s.sender.deliver(team(target.accountId), DAY)).toEqual({ status: "retry", afterSec: 5 });
    expect(s.events).toEqual([]);
  });

  it("события нет и там, где бот не писал: окно вида занято", async () => {
    const target = await player(s);
    const first = request(target.accountId);
    await s.sender.deliver(first, DAY);
    expect(await s.sender.deliver(request(target.accountId), DAY)).toEqual({ status: "skipped", reason: "throttled" });
    expect(s.events).toHaveLength(1);
  });

  it("напоминание днём идёт в тот же счётчик звука; ночью пропускается, как раньше", async () => {
    const withReminders = setup({ "reminders.enabled": true });
    const target = await player(withReminders);
    const reminder: BotNotifyJob = { notificationId: randomUUID(), accountId: target.accountId, kind: "daily_reward_ready", payload: {} };
    expect(await withReminders.sender.deliver({ ...reminder, notificationId: randomUUID() }, NIGHT)).toEqual({ status: "skipped", reason: "quiet_hours" });
    expect(await withReminders.sender.deliver(reminder, DAY)).toEqual({ status: "sent" });
    expect(withReminders.redis.counts.size).toBe(1);
  });
});

describe("очередь: отложенное до конца тихих часов задание", () => {
  const accountId = randomUUID();
  const notificationId = randomUUID();

  function queueWith(delivery: BotDelivery) {
    const feed = memoryNotifications();
    const added: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
    const received: BotNotifyJob[] = [];
    const sender = {
      deliver: async (job: BotNotifyJob) => {
        received.push(job);
        return delivery;
      },
    } as unknown as BotNotifySender;
    const queue = new BotNotifyQueue(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), feed.service, sender);
    (queue as unknown as { queue: unknown }).queue = {
      add: async (name: string, data: unknown, options: Record<string, unknown>) => {
        added.push({ name, data, options });
      },
    };
    return { queue, added, feed, received };
  }

  it("deferred — повторная постановка с задержкой в afterSec и jobId «<id>-q»; MAX_DEFERRALS не тратится", async () => {
    const { queue, added, feed } = queueWith({ status: "deferred", afterSec: UNTIL_MORNING_SEC });
    const data = { notificationId, accountId, kind: "friend_request", payload: {}, deferrals: 3 };
    await queue.process({ data });

    expect(added).toHaveLength(1);
    expect(added[0]?.options).toMatchObject({ jobId: `${notificationId}-q`, delay: UNTIL_MORNING_SEC * 1000 });
    expect(added[0]?.data).toMatchObject({ notificationId, deferrals: 3, quietDeferred: true });
    expect(feed.repository.rows).toEqual([]);
  });

  it("отметка quietDeferred доходит до отправителя, чтобы он не откладывал задание второй раз", async () => {
    const { queue, added, received } = queueWith({ status: "sent" });
    await queue.process({ data: { notificationId, accountId, kind: "friend_request", payload: {}, quietDeferred: true } });
    expect(received[0]?.quietDeferred).toBe(true);
    expect(added).toEqual([]);
  });

  it("задание из Redis с неверным quietDeferred — ошибка схемы", async () => {
    const { queue } = queueWith({ status: "sent" });
    await expect(queue.process({ data: { notificationId, accountId, kind: "friend_request", payload: {}, quietDeferred: "да" } })).rejects.toThrow();
  });
});

describe("модуль дубля уведомлений", () => {
  it("импортирует BotMessagesModule, а тот отдаёт политику, события и сборку сообщений", () => {
    const imports = (Reflect.getMetadata("imports", NotificationsBotModule) as Type<unknown>[] | undefined) ?? [];
    expect(imports).toContain(BotMessagesModule);
    const exported = (Reflect.getMetadata("exports", BotMessagesModule) as Type<unknown>[] | undefined) ?? [];
    expect(exported).toEqual(expect.arrayContaining([BotMessagePolicy, BotMessageEvents, BotMessages]));
  });
});
