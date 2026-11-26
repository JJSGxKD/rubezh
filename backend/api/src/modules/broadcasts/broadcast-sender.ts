import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Messengers, type OutgoingMessage, type SendOutcome } from "../../platforms/ports/messenger.js";
import { plainTextOf } from "../../platforms/ports/rich-message.js";
import { BotMessageEvents } from "../bot-messages/bot-message-events.js";
import { BotMessages } from "../bot-messages/bot-messages.service.js";
import { MessagingService } from "../messaging/messaging.service.js";
import { parseBroadcastMarkdown } from "./broadcast-rich.js";
import { BROADCAST_RULES } from "./broadcast-rules.js";
import { BROADCASTS_REPOSITORY, type BroadcastRecord, type BroadcastsRepository } from "./broadcasts.repository.js";

/**
 * Пачка отправки рассылки (docs/29-admin-panel.md §7.3): берёт получателей,
 * пишет им в темпе площадки и говорит очереди, что дальше. Очередь вокруг —
 * BullMQ (`broadcasts-queue.ts`); здесь то, что проверяется без Redis.
 *
 * - 429 и сбой сети — пачка обрывается, получатель возвращается в очередь,
 *   следующая пачка — не раньше, чем просила площадка;
 * - блокировка — отметка у игрока: дальше он из аудиторий исключён;
 * - пауза и отмена видны со следующей пачки — через несколько секунд;
 * - оформленная рассылка уходит документом с темой «Новости» (Р199, T-0403),
 *   на каждого получателя — событие `bot_message_sent`.
 */

export type BatchOutcome = { kind: "continue" } | { kind: "wait"; afterSec: number } | { kind: "done" } | { kind: "stopped" };

type MessageSource = Pick<BroadcastRecord, "format" | "text" | "buttonText" | "buttonUrl">;

/**
 * Сообщение рассылки и признак «разметка не прошла проверку». Простая — текст
 * и кнопка на ссылку кампании, ничего сверх. Оформленная — документ из
 * Markdown через сборщик, который сам решает, уходит ли оформление (ключи
 * панели) и годен ли документ. Сервис не пускает такую рассылку к запуску;
 * если разметка всё же сломана (строка в базе правилась в обход), уходит
 * простой текст документа без оформления, а не исходник с `**`.
 */
function composed(broadcast: MessageSource, composer?: BotMessages): { message: OutgoingMessage; invalid: boolean } {
  const button = broadcast.buttonText !== null && broadcast.buttonUrl !== null ? { text: broadcast.buttonText, url: broadcast.buttonUrl } : null;
  if (broadcast.format !== "rich" || composer === undefined) return { message: { text: broadcast.text, button }, invalid: false };
  const { doc, problems } = parseBroadcastMarkdown(broadcast.text);
  if (problems.length > 0) return { message: { text: plainTextOf(doc), button, topic: "news" }, invalid: true };
  return { message: composer.compose(doc, { button, topic: "news" }), invalid: false };
}

/** Сообщение рассылки: текст и кнопка на ссылку кампании, если она есть; у оформленной — документ и тема. */
export function messageOf(broadcast: MessageSource, composer?: BotMessages): OutgoingMessage {
  return composed(broadcast, composer).message;
}

@Injectable()
export class BroadcastSender {
  private readonly logger = new Logger("broadcasts");
  /** Рассылки, о сломанной разметке которых уже записано в лог: одна запись на рассылку, а не на пачку. */
  private readonly invalidLogged = new Set<string>();
  /** Пауза между сообщениями; тест подменяет, чтобы не ждать. */
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @Inject(BROADCASTS_REPOSITORY) private readonly broadcasts: BroadcastsRepository,
    private readonly messengers: Messengers,
    private readonly messaging: MessagingService,
    @Optional() private readonly composer?: BotMessages,
    @Optional() private readonly events?: BotMessageEvents,
  ) {}

  async sendBatch(broadcastId: string): Promise<BatchOutcome> {
    const broadcast = await this.broadcasts.byId(broadcastId);
    if (broadcast === null || broadcast.status !== "sending") return { kind: "stopped" };
    const messenger = this.messengers.for(broadcast.platform);
    if (messenger === null) {
      // Бот пропал из конфигурации посреди рассылки — пауза, а не тихая потеря очереди.
      await this.broadcasts.transition(broadcastId, ["sending"], "paused", new Date());
      this.log("warn", "broadcast_paused_no_bot", { broadcastId, platform: broadcast.platform });
      return { kind: "stopped" };
    }

    const recipients = await this.broadcasts.claim(broadcastId, messenger.ratePerSec * BROADCAST_RULES.batchSec, BROADCAST_RULES.claimSec);
    if (recipients.length === 0) {
      if ((await this.broadcasts.stats(broadcastId)).queued > 0) return { kind: "wait", afterSec: BROADCAST_RULES.claimSec };
      if (await this.broadcasts.transition(broadcastId, ["sending"], "done", new Date())) this.log("log", "broadcast_done", { broadcastId });
      return { kind: "done" };
    }

    const { message, invalid } = composed(broadcast, this.composer);
    if (invalid && !this.invalidLogged.has(broadcastId)) {
      this.invalidLogged.add(broadcastId);
      this.log("warn", "broadcast_rich_invalid", { broadcastId });
    }
    const gapMs = Math.ceil(1000 / messenger.ratePerSec);
    for (const [index, recipient] of recipients.entries()) {
      const outcome = await messenger.send(recipient.platformUserId, message);
      if (outcome.status === "retry") {
        const deferrals = await this.broadcasts.defer(broadcastId, recipient.accountId);
        if (deferrals >= BROADCAST_RULES.maxDeferrals) await this.broadcasts.record(broadcastId, recipient.accountId, { status: "failed", error: "deferred" });
        await this.broadcasts.release(broadcastId, recipients.slice(index + 1).map((rest) => rest.accountId));
        return { kind: "wait", afterSec: Math.max(outcome.afterSec, 1) };
      }
      const at = new Date();
      if (outcome.status === "failed") {
        await this.broadcasts.record(broadcastId, recipient.accountId, { status: "failed", error: outcome.reason.slice(0, 32) });
      } else {
        await this.broadcasts.record(broadcastId, recipient.accountId, { status: outcome.status, at });
        if (outcome.status === "blocked") await this.messaging.platformChanged(broadcast.platform, recipient.platformUserId, "blocked", at);
      }
      await this.reportSent(broadcast.platform, message, outcome);
      await this.pause(gapMs);
    }
    return { kind: "continue" };
  }

  /** `bot_message_sent` на окончательный исход получателя; повтор (`retry`) сюда не доходит. */
  private async reportSent(platform: BroadcastRecord["platform"], message: OutgoingMessage, outcome: Exclude<SendOutcome, { status: "retry" }>): Promise<void> {
    if (this.events === undefined) return;
    const fellBack = outcome.status === "sent" && outcome.fallback === true;
    await this.events.sent({
      kind: "news",
      format: message.rich !== undefined && !fellBack ? "rich" : "text",
      outcome: fellBack ? "fallback" : outcome.status,
      topic: message.topic ?? "none",
      silent: false,
      platform,
    });
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "broadcasts", event, ...fields }));
  }
}
