import { Module } from "@nestjs/common";
import { EventsController } from "./events.controller.js";
import { EVENTS_REPOSITORY, PrismaEventsRepository } from "./events.repository.js";
import { EventsService } from "./events.service.js";
import { EVENTS_SINK, QueuedEventsSink } from "./events.sink.js";

/**
 * События закрытого теста (docs/26-stage2-plan.md, WP8): приём пачкой,
 * очередь, батч-вставка в Postgres. Выключен по умолчанию —
 * `EVENTS_INGEST_ENABLED`.
 */
@Module({
  controllers: [EventsController],
  providers: [
    EventsService,
    { provide: EVENTS_REPOSITORY, useClass: PrismaEventsRepository },
    { provide: EVENTS_SINK, useClass: QueuedEventsSink },
  ],
})
export class EventsModule {}
