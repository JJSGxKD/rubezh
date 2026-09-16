import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { IngestEndpoint, IngestGuard, ingestIdentityOf } from "../ingest/ingest.guard.js";
import { EventsService, type IngestResult } from "./events.service.js";

/**
 * Приёмник событий (docs/22-analytics-and-metrics.md §3.2): пачка, ответ
 * `202` — событие принято к записи, а не записано. Логики здесь нет.
 */
@Controller("events")
@UseGuards(IngestGuard)
export class EventsController {
  constructor(private readonly service: EventsService) {}

  @Post()
  @HttpCode(202)
  @IngestEndpoint("events")
  async ingest(@Req() request: unknown, @Body() body: unknown): Promise<{ data: IngestResult }> {
    return { data: await this.service.ingest(body, ingestIdentityOf(request), Date.now()) };
  }
}
