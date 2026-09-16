import { Inject, Injectable } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import type { IngestIdentity } from "../ingest/ingest.guard.js";
import { INGEST_LIMITS } from "../ingest/ingest-limits.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { eventBatchSchema, eventEnvelopeSchema } from "./dto/event-batch.dto.js";
import { EVENT_DICTIONARY, isEventType } from "./event-dictionary.js";
import type { EventRow } from "./events.repository.js";
import { EVENTS_SINK, type EventsSink } from "./events.sink.js";

/** Почему событие не записано — счётчиками в ответе, без текста ошибок схемы. */
export type RejectReason = "envelope" | "unknown_type" | "unknown_version" | "payload";

export interface IngestResult {
  accepted: number;
  rejected: number;
  rejectedBy: Partial<Record<RejectReason, number>>;
}

@Injectable()
export class EventsService {
  constructor(
    @Inject(EVENTS_SINK) private readonly sink: EventsSink,
    private readonly limiter: RateLimiter,
  ) {}

  async ingest(body: unknown, identity: IngestIdentity, nowMs: number): Promise<IngestResult> {
    const batch = eventBatchSchema.safeParse(body);
    if (!batch.success) throw new ValidationError("Некорректная пачка событий");

    const receivedAt = new Date(nowMs).toISOString();
    const rows: EventRow[] = [];
    const rejectedBy: Partial<Record<RejectReason, number>> = {};
    const reject = (reason: RejectReason): void => {
      rejectedBy[reason] = (rejectedBy[reason] ?? 0) + 1;
    };

    for (const raw of batch.data.events) {
      const envelope = eventEnvelopeSchema.safeParse(raw);
      if (!envelope.success) {
        reject("envelope");
        continue;
      }
      const event = envelope.data;
      if (!isEventType(event.eventType)) {
        reject("unknown_type");
        continue;
      }
      const definition = EVENT_DICTIONARY[event.eventType];
      if (event.schemaVersion !== definition.version) {
        reject("unknown_version");
        continue;
      }
      const payload = definition.payload.safeParse(event.payload);
      if (!payload.success) {
        reject("payload");
        continue;
      }
      rows.push({
        eventId: event.eventId,
        eventType: event.eventType,
        schemaVersion: event.schemaVersion,
        installId: event.installId,
        // Telegram ID — только из проверенной подписи, а не из тела события.
        platformUserId: identity.platformUserId,
        sessionId: event.sessionId,
        platform: event.platform,
        appVersion: event.appVersion,
        payload: payload.data,
        occurredAt: new Date(event.occurredAt).toISOString(),
        receivedAt,
      });
    }

    await this.enforceLimits(rows, identity);
    await this.sink.write(rows);

    const rejected = batch.data.events.length - rows.length;
    return { accepted: rows.length, rejected, rejectedBy };
  }

  /** Лимиты считаются в событиях, а не в запросах: пачка на сто событий стоит сотню. */
  private async enforceLimits(rows: readonly EventRow[], identity: IngestIdentity): Promise<void> {
    const perInstall = new Map<string, number>();
    for (const row of rows) perInstall.set(row.installId, (perInstall.get(row.installId) ?? 0) + 1);
    const limits = INGEST_LIMITS.events;
    for (const [installId, count] of perInstall) {
      if (!(await this.limiter.consume(limits.install, installId, count))) {
        throw new RateLimitedError("Слишком много событий с устройства, попробуйте позже");
      }
    }
    if (identity.platformUserId !== null && rows.length > 0) {
      if (!(await this.limiter.consume(limits.user, identity.platformUserId, rows.length))) {
        throw new RateLimitedError("Слишком много событий, попробуйте позже");
      }
    }
  }
}
