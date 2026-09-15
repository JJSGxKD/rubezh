import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { IngestEndpoint, IngestGuard, ingestIdentityOf } from "../ingest/ingest.guard.js";
import { DiagnosticsService, type ReceiveResult } from "./diagnostics.service.js";

/**
 * Приёмник отчётов диагностики (docs/28-diagnostics.md §5.1). Повтор с тем же
 * `reportId` — тоже `200`, с признаком дубликата: клиент удаляет отчёт из
 * очереди в обоих случаях. Эндпоинтов чтения нет — читают выгрузкой.
 */
@Controller("diagnostics")
@UseGuards(IngestGuard)
export class DiagnosticsController {
  constructor(private readonly service: DiagnosticsService) {}

  @Post("reports")
  @HttpCode(200)
  @IngestEndpoint("reports")
  async receive(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ReceiveResult }> {
    return { data: await this.service.receive(body, ingestIdentityOf(request), new Date()) };
  }
}
