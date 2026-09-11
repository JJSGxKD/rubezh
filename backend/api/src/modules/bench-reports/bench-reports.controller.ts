import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { ValidationError } from "../../common/domain-error";
import { submitBenchReportSchema } from "./dto/bench-report.dto";
import { BenchReportsService } from "./bench-reports.service";
import { BenchTokenGuard } from "./bench-token.guard";
import type { BenchReportSummary } from "./types/stored-bench-report";
import type { SubmitResult } from "./bench-reports.service";

/**
 * Приём отчётов FPS-испытаний с реальных устройств.
 *
 * В контроллере нет логики — только разбор границы и форма ответа
 * (docs/15-engineering-standards.md §2.3).
 */
@Controller("bench-reports")
@UseGuards(BenchTokenGuard)
export class BenchReportsController {
  constructor(private readonly service: BenchReportsService) {}

  @Post()
  async submit(@Body() body: unknown): Promise<{ data: SubmitResult }> {
    return { data: await this.service.submit(parseBody(body)) };
  }

  @Get()
  async list(@Query("limit") limit?: string): Promise<{ data: BenchReportSummary[] }> {
    const parsed = Number(limit);
    return { data: await this.service.list(Number.isFinite(parsed) ? parsed : undefined) };
  }
}

/**
 * Тело парсится схемой, а не приводится через `as`: это данные с границы
 * системы (CLAUDE.md, «Стиль кода»).
 */
function parseBody(body: unknown) {
  try {
    return submitBenchReportSchema.parse(body);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      throw new ValidationError(
        `Некорректный отчёт: ${first.path.join(".")} — ${first.message}`,
      );
    }
    throw error;
  }
}
