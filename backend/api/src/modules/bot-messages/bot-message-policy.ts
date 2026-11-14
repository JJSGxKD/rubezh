import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { isQuietHour } from "../reminders/reminder-rules.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { gameDayOf, loudKey, quietEndsAt } from "./bot-message-rules.js";

/**
 * Звук и время сообщений бота (docs/35-stage4-plan.md Р199, WP52, правило 6).
 * Откуда сообщение — от этого зависит всё:
 *
 * - `reply` — ответ на касание или команду: всегда, со звуком;
 * - `player` — вызвано самим игроком в игре: без звука;
 * - `bot` — бот пишет сам: в тихие часы напоминание пропускается, остальное
 *   ждёт их конца; со звуком — не больше `bot.loud-per-day` в игровые сутки на
 *   игрока, остальные без звука.
 *
 * Выключен `bot.formats.enabled` — бот пишет как до Р199: со звуком, без
 * ожидания, счётчик не трогается.
 */

export type MessageOrigin = "reply" | "player" | "bot";

export type BotMessageDecision = { action: "send"; silent: boolean } | { action: "wait"; untilMs: number } | { action: "skip"; reason: "quiet_hours" };

export interface BotMessageInput {
  accountId: string;
  origin: MessageOrigin;
  /** напоминание: в тихие часы не ждёт утра, а пропускается — как в правилах напоминаний (T-0128) */
  reminder?: boolean;
}

/** Счётчик и срок одним скриптом: два сообщения в одну миллисекунду не получат одно значение и не оставят ключ без срока. */
const LOUD_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

/** Двое суток: счётчик одних игровых суток переживает их границу и часовые пояса реплик. */
const LOUD_TTL_SEC = 2 * 86_400;
const REDIS_TIMEOUT_MS = 2_000;
/** Сбой Redis повторяется на каждом сообщении — в лог не чаще раза в минуту. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class BotMessagePolicy {
  private readonly logger = new Logger("bot-messages");
  private lastFailureLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "eval">,
    @Inject(SETTINGS_READER) private readonly panel: SettingsReader,
  ) {}

  async decide(input: BotMessageInput, now: Date): Promise<BotMessageDecision> {
    if (!this.panel.get(SETTINGS.botFormatsEnabled)) return { action: "send", silent: false };
    if (input.origin === "reply") return { action: "send", silent: false };
    if (input.origin === "player") return { action: "send", silent: true };

    const fromHour = this.panel.get(SETTINGS.remindersQuietFromHour);
    const toHour = this.panel.get(SETTINGS.remindersQuietToHour);
    if (isQuietHour(now, fromHour, toHour)) {
      return input.reminder === true ? { action: "skip", reason: "quiet_hours" } : { action: "wait", untilMs: quietEndsAt(now, fromHour, toHour).getTime() };
    }
    return { action: "send", silent: !(await this.hasLoudLeft(input.accountId, now)) };
  }

  /**
   * Место со звуком в игровых сутках. Счётчик растёт до отправки: неотправленное
   * сообщение место тоже занимает, и это допустимо. Redis недоступен — без
   * звука: лишний звук хуже тихого сообщения.
   */
  private async hasLoudLeft(accountId: string, now: Date): Promise<boolean> {
    try {
      const count = Number(await withTimeout(this.redis.eval(LOUD_SCRIPT, 1, loudKey(accountId, gameDayOf(now)), String(LOUD_TTL_SEC)), REDIS_TIMEOUT_MS, "счётчик звука бота"));
      return count <= this.panel.get(SETTINGS.botLoudPerDay);
    } catch (error: unknown) {
      this.warnFailure(error, now.getTime());
      return false;
    }
  }

  private warnFailure(error: unknown, nowMs: number): void {
    if (nowMs - this.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLoggedAt = nowMs;
    this.logger.warn(JSON.stringify({ module: "bot-messages", event: "loud_counter_unavailable", reason: error instanceof Error ? error.message : String(error) }));
  }
}
