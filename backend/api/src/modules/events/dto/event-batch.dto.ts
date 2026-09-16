import { z } from "zod";

/**
 * Конверт события (docs/22-analytics-and-metrics.md §3.1). Пачка разбирается
 * в два шага: сначала форма пачки, потом каждое событие отдельно — одно
 * битое событие не должно выбрасывать остальные девяносто девять.
 */
export const MAX_EVENTS_PER_BATCH = 100;

/** Установка и заход — uuid или 32 шестнадцатеричных знака (`app-shell/src/state/install.ts`). */
const deviceId = z.string().regex(/^[0-9a-zA-Z-]{8,64}$/);

export const eventBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
});

export const eventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().max(64),
  schemaVersion: z.number().int().min(1).max(1000),
  occurredAt: z.iso.datetime({ offset: true }),
  installId: deviceId,
  sessionId: deviceId,
  platform: z.enum(["telegram", "max", "vk", "web"]),
  appVersion: z.string().min(1).max(64),
  payload: z.record(z.string().max(64), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
