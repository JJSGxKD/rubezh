import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import type { SendOutcome } from "../../platforms/ports/messenger.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { accountOf } from "../auth/auth.guard.js";
import type { BroadcastRecord } from "../broadcasts/broadcasts.repository.js";
import { BroadcastsService, type BroadcastView } from "../broadcasts/broadcasts.service.js";
import { segmentSchema } from "../broadcasts/segment.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Рассылки в бота (docs/29-admin-panel.md §7): черновик и аудитория — право
 * `broadcast.edit`, старт, пауза и отмена — `broadcast.send`, одобрение —
 * `broadcast.approve`. Решает сервис, гвард — первая дверь.
 */
const editSchema = z.object({
  title: z.string().trim().min(1).max(120),
  /** 4096 — потолок сообщения Telegram */
  text: z.string().trim().min(1).max(4096),
  buttonText: z.string().trim().min(1).max(64).nullable().default(null),
  segment: segmentSchema,
});
const createSchema = editSchema.extend({ platform: z.enum(PLATFORM_IDS).default("telegram") });
const estimateSchema = z.object({ platform: z.enum(PLATFORM_IDS).default("telegram"), segment: segmentSchema });
const idSchema = z.string().uuid();

const EDIT_MESSAGE = "Нужны название, текст до 4096 знаков и корректная аудитория";

@Controller("admin/broadcasts")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminBroadcastsController {
  constructor(
    private readonly broadcasts: BroadcastsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("broadcast.edit")
  async list(@Req() request: unknown): Promise<{ data: { broadcasts: BroadcastRecord[] } }> {
    return { data: { broadcasts: await this.broadcasts.list(accountOf(request)) } };
  }

  @Post()
  @RequirePermission("broadcast.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: BroadcastRecord }> {
    const actor = await this.limited(request);
    const input = parse(() => createSchema.parse(body), EDIT_MESSAGE);
    return { data: await this.broadcasts.create(actor, input) };
  }

  /** Сколько человек получит — до сохранения черновика. */
  @Post("estimate")
  @RequirePermission("broadcast.edit")
  async estimate(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { audience: number } }> {
    const actor = await this.limited(request);
    const input = parse(() => estimateSchema.parse(body), "Некорректная аудитория");
    return { data: await this.broadcasts.estimate(actor, input.platform, input.segment) };
  }

  @Get(":id")
  @RequirePermission("broadcast.edit")
  async view(@Req() request: unknown, @Param("id") id: string): Promise<{ data: BroadcastView }> {
    return { data: await this.broadcasts.view(accountOf(request), idOf(id)) };
  }

  @Post(":id")
  @RequirePermission("broadcast.edit")
  async update(@Req() request: unknown, @Param("id") id: string, @Body() body: unknown): Promise<{ data: BroadcastRecord }> {
    const actor = await this.limited(request);
    const input = parse(() => editSchema.parse(body), EDIT_MESSAGE);
    return { data: await this.broadcasts.update(actor, idOf(id), input) };
  }

  @Post(":id/test")
  @RequirePermission("broadcast.edit")
  async test(@Req() request: unknown, @Param("id") id: string): Promise<{ data: SendOutcome }> {
    const actor = await this.limited(request, ADMIN_LIMITS.broadcastTest);
    return { data: await this.broadcasts.testSend(actor, idOf(id)) };
  }

  @Post(":id/approve")
  @RequirePermission("broadcast.approve")
  async approve(@Req() request: unknown, @Param("id") id: string): Promise<{ data: BroadcastRecord }> {
    return { data: await this.broadcasts.approve(await this.limited(request), idOf(id)) };
  }

  @Post(":id/start")
  @RequirePermission("broadcast.send")
  async start(@Req() request: unknown, @Param("id") id: string): Promise<{ data: { audience: number } }> {
    return { data: await this.broadcasts.start(await this.limited(request), idOf(id)) };
  }

  @Post(":id/pause")
  @RequirePermission("broadcast.send")
  async pause(@Req() request: unknown, @Param("id") id: string): Promise<{ data: BroadcastRecord }> {
    return { data: await this.broadcasts.pause(await this.limited(request), idOf(id)) };
  }

  @Post(":id/resume")
  @RequirePermission("broadcast.send")
  async resume(@Req() request: unknown, @Param("id") id: string): Promise<{ data: BroadcastRecord }> {
    return { data: await this.broadcasts.resume(await this.limited(request), idOf(id)) };
  }

  @Post(":id/cancel")
  @RequirePermission("broadcast.send")
  async cancel(@Req() request: unknown, @Param("id") id: string): Promise<{ data: BroadcastRecord }> {
    return { data: await this.broadcasts.cancel(await this.limited(request), idOf(id)) };
  }

  private async limited(request: unknown, rule: RateLimit = ADMIN_LIMITS.mutate) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(rule, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите");
    return actor;
  }
}

function idOf(value: string): string {
  return parse(() => idSchema.parse(value), "Некорректная рассылка");
}
