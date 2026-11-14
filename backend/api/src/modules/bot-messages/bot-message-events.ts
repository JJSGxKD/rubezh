import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { EVENT_DICTIONARY } from "../events/event-dictionary.js";
import type { EventRow } from "../events/events.repository.js";
import { EVENTS_SINK, type EventsSink } from "../events/events.sink.js";

/**
 * Серверное событие `bot_message_sent` (docs/22-analytics-and-metrics.md §3.3):
 * каждое сообщение бота — как оно ушло, в каком виде и со звуком ли. Пишется
 * всегда, независимо от выключателей: аналитика игроку ничего не меняет.
 *
 * Конверт, как у `run_scored`: у сервера нет устройства, поэтому
 * `install_id = 'server'`, игрока в строке нет. Сбой записи отправку не
 * роняет — событие аналитика, а не запись.
 */

const EVENT_TIMEOUT_MS = 2_000;
const SERVER_INSTALL_ID = "server";

export interface BotMessageSent {
  /** вид сообщения: вид уведомления, `season_card`, … */
  kind: string;
  format: "text" | "photo" | "rich" | "card";
  outcome: "sent" | "blocked" | "failed" | "fallback";
  topic: "none" | "news" | "rewards" | "support";
  silent: boolean;
  platform: PlatformId;
}

@Injectable()
export class BotMessageEvents {
  private readonly logger = new Logger("bot-messages");
  private warned = false;

  constructor(@Optional() @Inject(EVENTS_SINK) private readonly sink: EventsSink | null = null) {}

  async sent(message: BotMessageSent): Promise<void> {
    if (this.sink === null) return;
    try {
      const eventId = randomUUID();
      const at = new Date().toISOString();
      const row: EventRow = {
        eventId,
        eventType: "bot_message_sent",
        schemaVersion: EVENT_DICTIONARY.bot_message_sent.version,
        installId: SERVER_INSTALL_ID,
        platformUserId: null,
        sessionId: eventId,
        platform: message.platform,
        appVersion: "server",
        payload: EVENT_DICTIONARY.bot_message_sent.payload.parse({ kind: message.kind, format: message.format, outcome: message.outcome, topic: message.topic, silent: message.silent }),
        occurredAt: at,
        receivedAt: at,
      };
      await withTimeout(this.sink.write([row]), EVENT_TIMEOUT_MS, "событие сообщения бота");
    } catch (error: unknown) {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn(JSON.stringify({ module: "bot-messages", event: "event_failed", reason: error instanceof Error ? error.message : String(error) }));
    }
  }
}
