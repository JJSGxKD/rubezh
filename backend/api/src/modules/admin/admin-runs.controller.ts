import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { liftSchema } from "../restrictions/restriction-rules.js";
import type { Difficulty } from "../runs/run-rules.js";
import { RunsViewService, type ModerationRunView } from "../runs/runs-view.service.js";
import { RunsService } from "../runs/runs.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { accountIdSchema } from "./dto/admin.dto.js";

/**
 * Забеги игрока в рейтинге — для модератора (docs/35-stage4-plan.md WP44,
 * часть 3б): снять сомнительный рекорд с рейтинга или вернуть, с причиной.
 * Ограничение рейтинга закрывает его на срок; без этого рекорд, поставленный
 * до ограничения, вернулся бы вместе с игроком.
 */

const runIdSchema = z.string().min(8).max(64);

@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminRunsController {
  constructor(
    private readonly view: RunsViewService,
    private readonly runs: RunsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("players/:accountId/runs/rating")
  @RequirePermission("players.view")
  async ratingRuns(@Param("accountId") accountId: string): Promise<{ data: { runs: Record<Difficulty, ModerationRunView[]> } }> {
    const id = parse(() => accountIdSchema.parse(accountId), "Некорректный идентификатор аккаунта");
    return { data: { runs: await this.view.moderationRuns(id) } };
  }

  @Post("runs/:runId/unrank")
  @RequirePermission("players.restrict")
  async unrank(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: { accountId: string; ranked: boolean } }> {
    return { data: await this.change(request, runId, body, false) };
  }

  @Post("runs/:runId/rerank")
  @RequirePermission("players.restrict")
  async rerank(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: { accountId: string; ranked: boolean } }> {
    return { data: await this.change(request, runId, body, true) };
  }

  private async change(request: unknown, runId: string, body: unknown, ranked: boolean): Promise<{ accountId: string; ranked: boolean }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    const id = parse(() => runIdSchema.parse(runId), "Некорректный идентификатор забега");
    // Причина — та же, что у снятия ограничения: от 1 до 500 знаков, остаётся в аудите.
    const { comment } = parse(() => liftSchema.parse(body), "Нужна причина");
    return await this.runs.setRanked(actor, id, ranked, comment);
  }
}
