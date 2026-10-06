import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { accountOf } from "../auth/auth.guard.js";
import { FLAG_KEY } from "../flags/flag-rollout.js";
import type { FlagRecord } from "../flags/flags.repository.js";
import { FlagsService } from "../flags/flags.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Флаги и выкат в панели (docs/29-admin-panel.md §2): право `flags.edit`, каждое изменение — в аудит. */
const flagSchema = z.object({
  key: z.string().regex(FLAG_KEY, "ключ — латиница в нижнем регистре, цифры, точка, дефис"),
  enabled: z.boolean(),
  platforms: z.array(z.enum(PLATFORM_IDS)).max(PLATFORM_IDS.length).default([]),
  percent: z.number().int().min(0).max(100),
  note: z.string().trim().max(200).optional(),
});

@Controller("admin/flags")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminFlagsController {
  constructor(
    private readonly flags: FlagsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("flags.edit")
  async list(@Req() request: unknown): Promise<{ data: { flags: FlagRecord[] } }> {
    return { data: { flags: await this.flags.list(accountOf(request)) } };
  }

  @Post()
  @RequirePermission("flags.edit")
  async save(@Req() request: unknown, @Body() body: unknown): Promise<{ data: FlagRecord }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const input = parse(() => flagSchema.parse(body), "Некорректный флаг");
    return { data: await this.flags.save(actor, { ...input, platforms: [...new Set(input.platforms)], note: input.note || null }) };
  }

  @Post(":key/remove")
  @RequirePermission("flags.edit")
  async remove(@Req() request: unknown, @Param("key") key: string): Promise<{ data: { removed: boolean } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const parsed = parse(() => z.string().regex(FLAG_KEY).parse(key), "Некорректный ключ флага");
    return { data: await this.flags.remove(actor, parsed) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
