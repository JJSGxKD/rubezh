import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { imposeSchema, liftSchema, type RestrictionView } from "../restrictions/restriction-rules.js";
import { RestrictionsService, type RestrictionCatalogView } from "../restrictions/restrictions.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminPlayersService, type RestrictResult } from "./admin-players.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { accountIdSchema } from "./dto/admin.dto.js";

/**
 * Ограничения игрока в панели (docs/35-stage4-plan.md Р75, WP44): что можно
 * закрыть и почему, история в карточке, наложение и снятие. Право на
 * маршруте — общее, на каждый вид его проверяет сервис: блокировка целиком
 * требует `players.ban`.
 */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminRestrictionsController {
  constructor(
    private readonly restrictions: RestrictionsService,
    private readonly players: AdminPlayersService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("restrictions/catalog")
  @RequirePermission("players.view")
  catalog(): { data: RestrictionCatalogView } {
    return { data: this.restrictions.catalog() };
  }

  @Get("players/:accountId/restrictions")
  @RequirePermission("players.view")
  async history(@Req() request: unknown, @Param("accountId") accountId: string): Promise<{ data: { restrictions: RestrictionView[] } }> {
    return { data: { restrictions: await this.restrictions.history(accountOf(request), parseAccountId(accountId)) } };
  }

  @Post("players/:accountId/restrictions")
  @RequirePermission("players.restrict")
  async impose(@Req() request: unknown, @Param("accountId") accountId: string, @Body() body: unknown): Promise<{ data: RestrictResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const input = parse(() => imposeSchema.parse(body), "Некорректное ограничение: нужны виды, срок и причина");
    return { data: await this.players.restrict(actor, parseAccountId(accountId), input) };
  }

  @Post("restrictions/:restrictionId/lift")
  @RequirePermission("players.restrict")
  async lift(@Req() request: unknown, @Param("restrictionId") restrictionId: string, @Body() body: unknown): Promise<{ data: RestrictionView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const id = parse(() => z.uuid().parse(restrictionId), "Некорректный идентификатор ограничения");
    const { comment } = parse(() => liftSchema.parse(body), "Нужна причина снятия");
    return { data: await this.restrictions.lift(actor, id, comment) };
  }

  private async limit(actorId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actorId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

function parseAccountId(value: string): string {
  return parse(() => accountIdSchema.parse(value), "Некорректный идентификатор аккаунта");
}
