import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { AppLinks } from "../../platforms/ports/app-links.js";
import { Messengers, type SendOutcome } from "../../platforms/ports/messenger.js";
import { AccountSettingsService } from "../account-settings/account-settings.service.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { MessagingService } from "../messaging/messaging.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { isQuietHour, reminderWindowKey } from "../reminders/reminder-rules.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { botRuleOf, type BotNotifyRule } from "./bot-notify-rules.js";
import { botMessageOf, REMINDER_OFF_ACTION } from "./bot-notify-texts.js";

/**
 * Дубль одного уведомления в бота (docs/35-stage4-plan.md Р51, WP28).
 * Очередь вокруг — BullMQ (`bot-notify-queue.ts`); здесь то, что проверяется
 * без Redis-очереди. По порядку — от дешёвого к дорогому:
 *
 * - напоминание при выключенном `reminders.enabled` или в тихие часы — не
 *   пишем, окно потолка не занимаем (tasks/T-0128);
 * - вид не дублируется, аккаунта нет, он заблокирован, у площадки нет бота —
 *   не пишем;
 * - писать нельзя: игрок не начинал разговор с ботом или заблокировал его;
 * - игрок выключил этот вид в настройках, а не выбирал — решает умолчание;
 * - потолок вида: второе сообщение за окно не уходит, оно ждёт в ленте; у
 *   напоминаний окно одно на все три вида и берётся из настроек;
 * - блокировка при отправке — отметка у игрока, дальше ему не пишут ни
 *   уведомления, ни рассылки.
 *
 * Исход — в строку ленты (`notification.bot_outcome`): по нему видно, доходят
 * ли сообщения, а «заблокировали после» — по `account_messaging`.
 */

const TIMEOUT_MS = 3_000;

export interface BotNotifyJob {
  notificationId: string;
  accountId: string;
  kind: string;
  payload: unknown;
}

export type SkipReason = "not_duplicated" | "no_account" | "banned" | "no_bot" | "not_allowed" | "opted_out" | "bad_payload" | "throttled" | "disabled" | "quiet_hours";

export type BotDelivery = SendOutcome | { status: "skipped"; reason: SkipReason };

@Injectable()
export class BotNotifySender {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    private readonly messengers: Messengers,
    private readonly links: AppLinks,
    // Токены — явно: у `Pick` в метаданных типов остаётся `Object`, и Nest не
    // нашёл бы, что внедрять.
    @Inject(MessagingService) private readonly messaging: Pick<MessagingService, "state" | "platformChanged">,
    @Inject(AccountSettingsService) private readonly settings: Pick<AccountSettingsService, "valueOf">,
    @Inject(NotificationsService) private readonly notifications: Pick<NotificationsService, "markBot">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "get">,
    // Включатель, окно потолка и тихие часы напоминаний — настройки панели, читаются на каждую отправку.
    @Inject(SETTINGS_READER) private readonly panel: SettingsReader,
  ) {}

  async deliver(job: BotNotifyJob, now = new Date()): Promise<BotDelivery> {
    const rule = botRuleOf(job.kind);
    if (rule === undefined) return skipped("not_duplicated");
    // Кнопка выкл. и тихие часы проверяются первыми и без обращений к базе: задание,
    // застрявшее в очереди до 21:00, в 21:05 не уходит, а окно потолка остаётся целым.
    if (rule.reminder === true) {
      if (!this.panel.get(SETTINGS.remindersEnabled)) return skipped("disabled");
      if (isQuietHour(now, this.panel.get(SETTINGS.remindersQuietFromHour), this.panel.get(SETTINGS.remindersQuietToHour))) return skipped("quiet_hours");
    }
    const account = await withTimeout(this.accounts.byId(job.accountId), TIMEOUT_MS, "аккаунт");
    if (account === null) return skipped("no_account");
    if (account.bannedAt !== null) return skipped("banned");
    const messenger = this.messengers.for(account.platform);
    if (messenger === null) return skipped("no_bot");

    const state = await withTimeout(this.messaging.state(job.accountId), TIMEOUT_MS, "можно ли писать");
    if (state?.canMessage !== true) return skipped("not_allowed");
    const chosen = await this.settings.valueOf(job.accountId, rule.setting);
    if (!(typeof chosen === "boolean" ? chosen : rule.byDefault)) return skipped("opted_out");

    const text = botMessageOf(job.kind, job.payload, (startParam) => this.links.launch(account.platform, startParam));
    if (text === null) return skipped("bad_payload");
    // У каждого напоминания кнопка выхода: без неё игрок мог бы только терпеть.
    const message = rule.reminder === true ? { ...text, action: REMINDER_OFF_ACTION } : text;
    if (!(await this.claim(job, rule))) return skipped("throttled");

    const outcome = await messenger.send(account.platformUserId, message);
    if (outcome.status === "retry") return outcome;
    if (outcome.status === "blocked") await this.messaging.platformChanged(account.platform, account.platformUserId, "blocked", now);
    await this.notifications.markBot(job.notificationId, outcome.status, now);
    return outcome;
  }

  /**
   * Место в окне вида — атомарно, `SET NX`: две реплики одно окно не
   * поделят. Повтор того же задания после сбоя площадки своё место узнаёт по
   * id уведомления и не считается вторым сообщением. У напоминаний ключ общий
   * на три вида, а окно — `reminders.min-gap-hours`.
   */
  private async claim(job: BotNotifyJob, rule: BotNotifyRule): Promise<boolean> {
    const throttleSec = rule.reminder === true ? this.panel.get(SETTINGS.remindersMinGapHours) * 3_600 : rule.throttleSec;
    if (throttleSec === 0) return true;
    const key = rule.reminder === true ? reminderWindowKey(job.accountId) : `bot-notify:${job.accountId}:${job.kind}`;
    const taken = await withTimeout(this.redis.set(key, job.notificationId, "EX", throttleSec, "NX"), TIMEOUT_MS, "окно дубля в бота");
    if (taken === "OK") return true;
    return (await withTimeout(this.redis.get(key), TIMEOUT_MS, "окно дубля в бота")) === job.notificationId;
  }
}

function skipped(reason: SkipReason): BotDelivery {
  return { status: "skipped", reason };
}
