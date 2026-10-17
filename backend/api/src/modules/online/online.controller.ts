import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AdminSessionGuard } from "../admin/admin-session.guard.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { OnlineService, type OnlineSnapshot, type PingResult } from "./online.service.js";

/**
 * Пинг раз в 45 с честно, 240 в час — запас на несколько вкладок; больше —
 * уже скрипт, который накручивает «в забеге».
 */
const PING_LIMIT: RateLimit = { scope: "online-ping", limit: 240, windowSec: 3600 };

const pingSchema = z.object({ inRun: z.boolean() });

/** Число людей в игре для игрока. Активность пишет сам `AuthGuard`, пинг нужен тишине. */
@Controller("online")
@UseGuards(AuthGuard)
export class OnlineController {
  constructor(
    private readonly online: OnlineService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("ping")
  async ping(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PingResult }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(PING_LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    const parsed = pingSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Нужно поле inRun: true или false");
    return { data: await this.online.ping(account, parsed.data.inRun, new Date()) };
  }
}

/** Онлайн по площадкам для панели: без порогов, с рекордом. */
@Controller("admin/online")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class OnlineAdminController {
  constructor(private readonly online: OnlineService) {}

  @Get()
  @RequirePermission("analytics.gameplay.view")
  async snapshot(): Promise<{ data: OnlineSnapshot }> {
    return { data: await this.online.adminSnapshot() };
  }
}
