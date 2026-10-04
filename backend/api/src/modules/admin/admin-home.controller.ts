import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { teamSlideInputSchema } from "../home/team-slide-rules.js";
import { TeamSlidesService, type TeamSlideAdminRow, type TeamSlideCatalogView } from "../home/team-slides.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Слайды команды на главной в панели (docs/35-stage4-plan.md WP42, часть 2):
 * завести, поправить, снять — под `home.edit`, каждое действие — в аудит.
 * Правка, в отличие от акции, разрешена: слайд — анонс, а не цена, и
 * опечатку в нём чинят на месте.
 */
@Controller("admin/home/slides")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminHomeController {
  constructor(
    private readonly slides: TeamSlidesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("home.edit")
  async list(@Req() request: unknown): Promise<{ data: TeamSlideCatalogView }> {
    return { data: await this.slides.catalog(accountOf(request)) };
  }

  @Post()
  @RequirePermission("home.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: TeamSlideAdminRow }> {
    const actor = await this.consume(request);
    const input = parse(() => teamSlideInputSchema.parse(body), "Некорректный слайд");
    return { data: await this.slides.create(actor, input) };
  }

  // Правка — POST, как во всей панели: другие методы её клиент не шлёт.
  @Post(":slideId")
  @RequirePermission("home.edit")
  async update(@Req() request: unknown, @Param("slideId") slideId: string, @Body() body: unknown): Promise<{ data: TeamSlideAdminRow }> {
    const actor = await this.consume(request);
    const id = parse(() => z.uuid().parse(slideId), "Некорректный id слайда");
    const input = parse(() => teamSlideInputSchema.parse(body), "Некорректный слайд");
    return { data: await this.slides.update(actor, id, input) };
  }

  @Post(":slideId/archive")
  @RequirePermission("home.edit")
  async archive(@Req() request: unknown, @Param("slideId") slideId: string): Promise<{ data: TeamSlideAdminRow }> {
    const actor = await this.consume(request);
    const id = parse(() => z.uuid().parse(slideId), "Некорректный id слайда");
    return { data: await this.slides.archive(actor, id) };
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
