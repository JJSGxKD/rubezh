import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { EVENT_DICTIONARY } from "../events/event-dictionary.js";
import type { EventRow } from "../events/events.repository.js";
import { EVENTS_SINK, type EventsSink } from "../events/events.sink.js";

/**
 * Серверное событие `bot_card_query` (docs/22-analytics-and-metrics.md §3.3): запрос из живой карточки
 * и чем он кончился — обновление и действие игрока. Пишется после каждого ответа, независимо от
 * выключателей: аналитика игроку ничего не меняет.
 *
 * Конверт, как у `bot_message_sent`: у сервера нет устройства, поэтому `install_id = 'server'`, игрока
 * в строке нет. Сбой записи ответ не роняет — событие аналитика, а не запись.
 */

const EVENT_TIMEOUT_MS = 2_000;
const SERVER_INSTALL_ID = "server";

export interface BotCardQuery {
  /** вид карточки; `unknown`, пока запрос не дошёл до карточки (мусор, чужой вход) */
  card: string;
  /** `refresh` для обновления, иначе имя действия вида; `unknown` — действие не из списка вида */
  action: string;
  outcome: "ok" | "already" | "locked" | "limited" | "off" | "error";
  platform: PlatformId;
}

@Injectable()
export class BotCardEvents {
  private readonly logger = new Logger("bot-cards");
  private warned = false;

  constructor(@Optional() @Inject(EVENTS_SINK) private readonly sink: EventsSink | null = null) {}

  async queried(query: BotCardQuery): Promise<void> {
    if (this.sink === null) return;
    try {
      const eventId = randomUUID();
      const at = new Date().toISOString();
      const row: EventRow = {
        eventId,
        eventType: "bot_card_query",
        schemaVersion: EVENT_DICTIONARY.bot_card_query.version,
        installId: SERVER_INSTALL_ID,
        platformUserId: null,
        sessionId: eventId,
        platform: query.platform,
        appVersion: "server",
        payload: EVENT_DICTIONARY.bot_card_query.payload.parse({ card: query.card, action: query.action, outcome: query.outcome }),
        occurredAt: at,
        receivedAt: at,
      };
      await withTimeout(this.sink.write([row]), EVENT_TIMEOUT_MS, "событие запроса карточки");
    } catch (error: unknown) {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn(JSON.stringify({ module: "bot-cards", event: "event_failed", reason: error instanceof Error ? error.message : String(error) }));
    }
  }
}
