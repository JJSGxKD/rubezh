import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotMessageEvents } from "../src/modules/bot-messages/bot-message-events.js";
import { BotMessagePolicy } from "../src/modules/bot-messages/bot-message-policy.js";
import { gameDayOf, loudKey, quietEndsAt } from "../src/modules/bot-messages/bot-message-rules.js";
import { BotMessages } from "../src/modules/bot-messages/bot-messages.service.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import type { EventRow } from "../src/modules/events/events.repository.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { RichDocument } from "../src/platforms/ports/rich-message.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Правила звука и тихих часов сообщений бота, событие `bot_message_sent` и
 * сборка оформленного сообщения (tasks/T-0394, Р199, правила 5 и 6). Время —
 * по Москве (UTC+3, без перехода на летнее).
 */

/** 12:00 по Москве — день; 23:30 — тихо при умолчании 21 → 10; 00:30 следующих суток — тихо, а по UTC ещё вчера. */
const DAY = new Date(Date.UTC(2026, 10, 4, 9, 0));
const NIGHT = new Date(Date.UTC(2026, 10, 4, 20, 30));
const AFTER_MIDNIGHT = new Date(Date.UTC(2026, 10, 4, 21, 30));
const NEXT_MORNING = Date.UTC(2026, 10, 5, 7, 0);

describe("правила тихих часов и игровых суток", () => {
  it("quietEndsAt: с 23:30 по Москве при окне 21–10 — завтра в 10:00 по Москве", () => {
    expect(quietEndsAt(NIGHT, 21, 10).getTime()).toBe(NEXT_MORNING);
  });

  it("quietEndsAt: в 09:59 — сегодня в 10:00; после полуночи — тоже сегодня в 10:00", () => {
    expect(quietEndsAt(new Date(Date.UTC(2026, 10, 4, 6, 59)), 21, 10).getTime()).toBe(Date.UTC(2026, 10, 4, 7, 0));
    expect(quietEndsAt(AFTER_MIDNIGHT, 21, 10).getTime()).toBe(Date.UTC(2026, 10, 5, 7, 0));
  });

  it("quietEndsAt: окно 1–5 на 03:00 — в 05:00; ровно в конце окна — следующий конец, а не «сейчас»", () => {
    expect(quietEndsAt(new Date(Date.UTC(2026, 10, 4, 0, 0)), 1, 5).getTime()).toBe(Date.UTC(2026, 10, 4, 2, 0));
    expect(quietEndsAt(new Date(Date.UTC(2026, 10, 4, 7, 0)), 21, 10).getTime()).toBe(Date.UTC(2026, 10, 5, 7, 0));
  });

  it("gameDayOf — дата по Москве: в 00:30 по Москве уже следующие сутки, хотя по UTC вчера", () => {
    expect(gameDayOf(DAY)).toBe("2026-11-04");
    expect(gameDayOf(AFTER_MIDNIGHT)).toBe("2026-11-05");
  });

  it("loudKey: аккаунт и игровой день", () => {
    expect(loudKey("acc-1", "2026-11-04")).toBe("bot-loud:acc-1:2026-11-04");
  });
});

/** Redis для счётчика: скрипт `INCR` + `EXPIRE` — считаем сами, срок запоминаем. */
class FakeRedis {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  calls = 0;
  broken = false;

  async eval(_script: string, _keys: number, key: string, ttlSec: string): Promise<number> {
    this.calls++;
    if (this.broken) throw new Error("Redis недоступен");
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    if (next === 1) this.ttls.set(key, Number(ttlSec));
    return next;
  }
}

function policyWith(values: Record<string, SettingValue> = {}) {
  const redis = new FakeRedis();
  const panel = panelSettings({ "bot.formats.enabled": true, ...values });
  return { redis, policy: new BotMessagePolicy(redis as unknown as Redis, panel) };
}

describe("решение о звуке и времени сообщения бота", () => {
  it("формат выключен — со звуком при любом источнике, как до Р199; счётчик не тронут", async () => {
    const { redis, policy } = policyWith({ "bot.formats.enabled": false });
    for (const origin of ["reply", "player", "bot"] as const) {
      expect(await policy.decide({ accountId: "a", origin }, NIGHT), origin).toEqual({ action: "send", silent: false });
    }
    expect(await policy.decide({ accountId: "a", origin: "bot", reminder: true }, NIGHT)).toEqual({ action: "send", silent: false });
    expect(redis.calls).toBe(0);
  });

  it("ответ на касание или команду — со звуком даже ночью; счётчик не тронут", async () => {
    const { redis, policy } = policyWith();
    expect(await policy.decide({ accountId: "a", origin: "reply" }, NIGHT)).toEqual({ action: "send", silent: false });
    expect(redis.calls).toBe(0);
  });

  it("сообщение, вызванное самим игроком, — без звука; счётчик не тронут", async () => {
    const { redis, policy } = policyWith();
    expect(await policy.decide({ accountId: "a", origin: "player" }, DAY)).toEqual({ action: "send", silent: true });
    expect(redis.calls).toBe(0);
  });

  it("бот пишет сам в тихий час: напоминание пропускается, остальное ждёт 10:00 по Москве", async () => {
    const { redis, policy } = policyWith();
    expect(await policy.decide({ accountId: "a", origin: "bot", reminder: true }, NIGHT)).toEqual({ action: "skip", reason: "quiet_hours" });
    expect(await policy.decide({ accountId: "a", origin: "bot" }, NIGHT)).toEqual({ action: "wait", untilMs: NEXT_MORNING });
    expect(redis.calls).toBe(0);
  });

  it("тихие часы берутся из ключей панели", async () => {
    const { policy } = policyWith({ "reminders.quiet-from-hour": 13, "reminders.quiet-to-hour": 15 });
    expect(await policy.decide({ accountId: "a", origin: "bot" }, NIGHT)).toEqual({ action: "send", silent: false });
    expect(await policy.decide({ accountId: "a", origin: "bot" }, new Date(Date.UTC(2026, 10, 4, 11, 0)))).toEqual({ action: "wait", untilMs: Date.UTC(2026, 10, 4, 12, 0) });
  });

  it("днём первые два сообщения бота со звуком, третье и дальше — без звука; срок счётчика — двое суток", async () => {
    const { redis, policy } = policyWith();
    const decide = () => policy.decide({ accountId: "a", origin: "bot" }, DAY);
    expect(await decide()).toEqual({ action: "send", silent: false });
    expect(await decide()).toEqual({ action: "send", silent: false });
    expect(await decide()).toEqual({ action: "send", silent: true });
    expect(await decide()).toEqual({ action: "send", silent: true });
    expect(redis.ttls.get(loudKey("a", "2026-11-04"))).toBe(172_800);
    // Другой игрок считается отдельно.
    expect(await policy.decide({ accountId: "b", origin: "bot" }, DAY)).toEqual({ action: "send", silent: false });
  });

  it("потолок — bot.loud-per-day из панели", async () => {
    const { policy } = policyWith({ "bot.loud-per-day": 1 });
    expect(await policy.decide({ accountId: "a", origin: "bot" }, DAY)).toEqual({ action: "send", silent: false });
    expect(await policy.decide({ accountId: "a", origin: "bot" }, DAY)).toEqual({ action: "send", silent: true });
  });

  it("игровые сутки — по Москве: в 00:30 по Москве счётчик новый, хотя по UTC ещё вчера", async () => {
    const { redis, policy } = policyWith({ "reminders.quiet-from-hour": 0, "reminders.quiet-to-hour": 0 });
    for (let index = 0; index < 3; index++) await policy.decide({ accountId: "a", origin: "bot" }, DAY);
    expect(await policy.decide({ accountId: "a", origin: "bot" }, AFTER_MIDNIGHT)).toEqual({ action: "send", silent: false });
    expect(redis.counts.get(loudKey("a", "2026-11-05"))).toBe(1);
    expect(redis.counts.get(loudKey("a", "2026-11-04"))).toBe(3);
  });

  describe("Redis недоступен", () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("без звука, а предупреждение в лог — не чаще раза в минуту", async () => {
      const { redis, policy } = policyWith();
      redis.broken = true;
      expect(await policy.decide({ accountId: "a", origin: "bot" }, DAY)).toEqual({ action: "send", silent: true });
      expect(await policy.decide({ accountId: "a", origin: "bot" }, new Date(DAY.getTime() + 30_000))).toEqual({ action: "send", silent: true });
      expect(warn).toHaveBeenCalledTimes(1);
      await policy.decide({ accountId: "a", origin: "bot" }, new Date(DAY.getTime() + 61_000));
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});

class FakeSink {
  readonly rows: EventRow[] = [];
  broken = false;

  async write(rows: readonly EventRow[]): Promise<void> {
    if (this.broken) throw new Error("очередь недоступна");
    this.rows.push(...rows);
  }
}

describe("событие bot_message_sent", () => {
  it("серверный конверт без игрока, нагрузка проходит схему словаря", async () => {
    const sink = new FakeSink();
    await new BotMessageEvents(sink).sent({ kind: "friend_request", format: "text", outcome: "fallback", topic: "none", silent: true, platform: "telegram" });

    expect(sink.rows).toHaveLength(1);
    const row = sink.rows[0] as EventRow;
    expect(row).toMatchObject({ eventType: "bot_message_sent", schemaVersion: EVENT_DICTIONARY.bot_message_sent.version, installId: "server", platformUserId: null, appVersion: "server", platform: "telegram" });
    expect(row.sessionId).toBe(row.eventId);
    expect(row.payload).toEqual({ kind: "friend_request", format: "text", outcome: "fallback", topic: "none", silent: true });
    expect(EVENT_DICTIONARY.bot_message_sent.payload.safeParse(row.payload).success).toBe(true);
  });

  it("без писателя событий — тихо; сбой записи не падает и пишется в лог один раз", async () => {
    await expect(new BotMessageEvents(null).sent({ kind: "x", format: "text", outcome: "sent", topic: "none", silent: false, platform: "telegram" })).resolves.toBeUndefined();

    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const sink = new FakeSink();
      sink.broken = true;
      const events = new BotMessageEvents(sink);
      const input = { kind: "x", format: "text", outcome: "sent", topic: "none", silent: false, platform: "telegram" } as const;
      await expect(events.sent(input)).resolves.toBeUndefined();
      await expect(events.sent(input)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("сборка оформленного сообщения", () => {
  const DOC: RichDocument = { blocks: [{ kind: "heading", text: "Итоги" }, { kind: "paragraph", text: "Ты четвёртый" }] };
  const BASE = { button: { text: "▶ Играть", url: "https://t.me/rubezh_bot/play" } };

  it("оба выключателя включены — rich и простой текст; кнопка, действие и тема переходят в сообщение", () => {
    const messages = new BotMessages(panelSettings({ "bot.formats.enabled": true }));
    const action = { text: "🔕", data: "rm:off" };
    expect(messages.compose(DOC, { ...BASE, action, topic: "rewards" })).toEqual({ text: "Итоги\n\nТы четвёртый", rich: DOC, button: BASE.button, action, topic: "rewards" });
    expect(messages.compose(DOC, BASE)).toEqual({ text: "Итоги\n\nТы четвёртый", rich: DOC, button: BASE.button });
  });

  it("общий выключатель выключен или оформление выключено — только простой текст", () => {
    for (const values of [{}, { "bot.formats.enabled": true, "bot.rich.enabled": false }]) {
      const composed = new BotMessages(panelSettings(values)).compose(DOC, BASE);
      expect(composed).toEqual({ text: "Итоги\n\nТы четвёртый", button: BASE.button });
      expect(composed).not.toHaveProperty("rich");
    }
  });

  it("документ с проблемами уходит простым текстом, а в лог — строка rich_rejected с первой проблемой", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const bad: RichDocument = { blocks: [{ kind: "buttons", buttons: [{ text: "Играть", url: "http://rubezh.example" }] }, { kind: "paragraph", text: "Текст" }] };
      const composed = new BotMessages(panelSettings({ "bot.formats.enabled": true })).compose(bad, BASE);
      expect(composed).not.toHaveProperty("rich");
      expect(composed.text).toBe("Играть: http://rubezh.example\n\nТекст");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("rich_rejected");
    } finally {
      warn.mockRestore();
    }
  });
});
