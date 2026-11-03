import { Inject, Injectable, Logger } from "@nestjs/common";
import { parseChatTarget } from "../../platforms/ports/chat-target.js";
import { Messengers } from "../../platforms/ports/messenger.js";
import { dayWindow, previousDay, REPORT_AT_MIN, teamDay } from "../admin-notify/daily-stats.js";
import { NotifyTargets } from "../settings/notify-targets.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { REMINDERS_REPOSITORY, type DaySummary, type RemindersRepository } from "./reminders.repository.js";
import { RemindersStore } from "./reminders.store.js";

/**
 * Суточный отчёт команде о напоминаниях (tasks/T-0128): раз в игровые сутки,
 * первым проходом после 00:10 по Москве, — сколько отправлено по видам, сколько
 * не доставлено и сколько игроков заблокировали бота после напоминания. Доля
 * блокировок — главный сигнал: по ней команда понимает, что бот надоедает.
 *
 * Реплик может быть несколько, а отчёт за сутки — один: сутки закрывает та, что
 * первой заняла метку `reminders:report:<день>` (`SET NX`). Сетевой сбой и
 * просьба площадки подождать метку снимают — отчёт уйдёт следующим проходом;
 * отказ (чат не найден, бота выгнали) — нет: повтор его не вылечит.
 *
 * Адрес — поток `notify.chat.reminders`, пустой — общий чат команды. Отправка
 * идёт портом `Messengers`: домен не знает, как площадка шлёт в чат.
 */

export type ReportStatus = "sent" | "already" | "not_due" | "disabled" | "no_chat" | "failed";

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

@Injectable()
export class RemindersReport {
  private readonly logger = new Logger("reminders");

  constructor(
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly targets: NotifyTargets,
    private readonly store: RemindersStore,
    @Inject(REMINDERS_REPOSITORY) private readonly repository: RemindersRepository,
    private readonly messengers: Messengers,
  ) {}

  /** Не бросает: отчёт — довесок к проходу, его сбой не должен ронять напоминания. */
  async runIfDue(now = new Date()): Promise<ReportStatus> {
    // Выключенные напоминания отчётов не шлют: иначе команда получала бы нули каждый день.
    if (!this.settings.get(SETTINGS.remindersEnabled)) return "disabled";
    const today = teamDay(now.getTime());
    if (now.getTime() < dayWindow(today).from.getTime() + REPORT_AT_MIN * 60_000) return "not_due";
    const day = previousDay(today);
    let claimed = false;
    try {
      if (!(await this.store.claimReport(day))) return "already";
      claimed = true;
      const target = parseChatTarget(this.settings.get(SETTINGS.chatReminders)) ?? this.targets.chats().general;
      const messenger = this.messengers.for("telegram");
      if (target === null || messenger === null || messenger.sendToChat === undefined) {
        this.logger.warn(JSON.stringify({ module: "reminders", event: "report_no_chat", day }));
        return "no_chat";
      }
      const { from, to } = dayWindow(day);
      const outcome = await messenger.sendToChat(target, reportText(day, await this.repository.daySummary({ from, to })));
      if (outcome.status === "sent") return "sent";
      this.logger.warn(JSON.stringify({ module: "reminders", event: "report_not_sent", day, outcome: outcome.status }));
      // Просьба подождать — временная, отказ — нет: повторять отчёт, который не примут, незачем.
      if (outcome.status === "retry") await this.release(day);
      return "failed";
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "reminders", event: "report_failed", day, reason: error instanceof Error ? error.message : "unknown" }));
      if (claimed) await this.release(day);
      return "failed";
    }
  }

  private async release(day: string): Promise<void> {
    await this.store.releaseReport(day).catch((error: unknown) => {
      this.logger.warn(JSON.stringify({ module: "reminders", event: "report_release_failed", day, reason: error instanceof Error ? error.message : "unknown" }));
    });
  }
}

/** Текст отчёта — для человека в чате команды. */
export function reportText(day: string, summary: DaySummary): string {
  const date = new Date(`${day}T00:00:00Z`);
  const sent = summary.sent.season_overtaken + summary.sent.season_closing + summary.sent.daily_reward_ready;
  return [
    `🔔 Напоминания за ${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""}`,
    `Обогнали в сезоне: отправлено ${String(summary.sent.season_overtaken)}`,
    `Сезон закрывается: отправлено ${String(summary.sent.season_closing)}`,
    `Награда дня: отправлено ${String(summary.sent.daily_reward_ready)}`,
    `Не доставлено: ${String(summary.undelivered)} · бота заблокировали: ${String(summary.blockedAfter)} (${share(summary.blockedAfter, sent)}% от отправленных)`,
  ].join("\n");
}

/** Доля в процентах с одним знаком после запятой, по-русски: `3,6`; ноль — просто `0`. */
function share(part: number, total: number): string {
  if (total === 0) return "0";
  return String(Math.round((part / total) * 1000) / 10).replace(".", ",");
}
