import { Inject, Injectable, Logger } from "@nestjs/common";
import { Messengers, type OutgoingMessage } from "../../platforms/ports/messenger.js";
import { MessagingService } from "../messaging/messaging.service.js";
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
 * - пауза и отмена видны со следующей пачки — через несколько секунд.
 */

export type BatchOutcome = { kind: "continue" } | { kind: "wait"; afterSec: number } | { kind: "done" } | { kind: "stopped" };

/** Сообщение рассылки: текст и кнопка на ссылку кампании, если она есть. */
export function messageOf(broadcast: Pick<BroadcastRecord, "text" | "buttonText" | "buttonUrl">): OutgoingMessage {
  const button = broadcast.buttonText !== null && broadcast.buttonUrl !== null ? { text: broadcast.buttonText, url: broadcast.buttonUrl } : null;
  return { text: broadcast.text, button };
}

@Injectable()
export class BroadcastSender {
  private readonly logger = new Logger("broadcasts");
  /** Пауза между сообщениями; тест подменяет, чтобы не ждать. */
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @Inject(BROADCASTS_REPOSITORY) private readonly broadcasts: BroadcastsRepository,
    private readonly messengers: Messengers,
    private readonly messaging: MessagingService,
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

    const message = messageOf(broadcast);
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
      await this.pause(gapMs);
    }
    return { kind: "continue" };
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "broadcasts", event, ...fields }));
  }
}
