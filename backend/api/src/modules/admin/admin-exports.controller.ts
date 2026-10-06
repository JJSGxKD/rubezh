import { createReadStream } from "node:fs";
import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import type { ExportJournalRow } from "../export/export.repository.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { AdminExportsService } from "./admin-exports.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse, periodOf } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { exportsLimitSchema, periodQuerySchema } from "./dto/admin.dto.js";

/**
 * Выгрузки в панели (docs/28-diagnostics.md §6; docs/29-admin-panel.md §2):
 * журнал и кнопка «собрать архив за период». Архив отдаётся файлом целиком —
 * у HTTP нет предела Bot API в 50 МБ, поэтому части здесь не нужны.
 */

/** Ровно то, что нужно от ответа Fastify для отдачи файла — без его типов. */
interface FileReply {
  header(name: string, value: string): unknown;
  send(payload: unknown): unknown;
  raw: { on(event: "finish" | "close", listener: () => void): unknown };
}

@Controller("admin/exports")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminExportsController {
  constructor(
    private readonly exports: AdminExportsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("data.export")
  async recent(@Query("limit") limit?: string): Promise<{ data: { exports: ExportJournalRow[] } }> {
    const parsed = parse(() => exportsLimitSchema.parse(limit ?? undefined), "Некорректный предел");
    return { data: { exports: await this.exports.recent(parsed) } };
  }

  /**
   * Собрать и отдать архив. Ответ пишется вручную: это файл, а не JSON. Итог
   * попадает в журнал выгрузок по событиям ответа — отправлен целиком или
   * соединение оборвалось раньше.
   */
  @Post()
  @RequirePermission("data.export")
  async build(@Req() request: unknown, @Body() body: unknown, @Res() reply: FileReply): Promise<void> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.export, actor.accountId))) throw new RateLimitedError("Выгрузка уже собирается — подождите");
    const period = periodOf(parse(() => periodQuerySchema.parse(body ?? {}), "Некорректный период"), new Date());

    const artifact = await this.exports.build(actor, period);
    let settled = false;
    const settle = (status: "sent" | "failed", error: string | null): void => {
      if (settled) return;
      settled = true;
      void this.exports.settle(artifact, status, error);
    };
    reply.raw.on("finish", () => settle("sent", null));
    reply.raw.on("close", () => settle("failed", "соединение закрыто до конца передачи"));

    reply.header("content-type", "application/zip");
    reply.header("content-length", String(artifact.sizeBytes));
    reply.header("content-disposition", `attachment; filename="${artifact.fileName}"`);
    reply.send(createReadStream(artifact.zipPath));
  }
}
