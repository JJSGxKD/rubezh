import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSocialService, type SocialView } from "./admin-social.service.js";
import { accountIdSchema, banSchema } from "./dto/admin.dto.js";

/** Друзья и рефералка игрока в панели (WP14, антифрод §2.4 рефералки). */
@Controller("admin/players")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminSocialController {
  constructor(
    private readonly social: AdminSocialService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":accountId/social")
  @RequirePermission("players.view")
  async view(@Param("accountId") accountId: string): Promise<{ data: SocialView }> {
    return { data: await this.social.social(idOf(accountId)) };
  }

  /** Отклонить привязку до активации — причина та же по форме, что у блокировки. */
  @Post(":accountId/referral/reject")
  @RequirePermission("players.ban")
  async reject(@Req() request: unknown, @Param("accountId") accountId: string, @Body() body: unknown): Promise<{ data: { rejected: boolean } }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    const { reason } = parse(() => banSchema.parse(body), "Нужна причина от 3 до 256 символов");
    return { data: await this.social.rejectReferral(actor, idOf(accountId), reason) };
  }
}

function idOf(value: string): string {
  return parse(() => accountIdSchema.parse(value), "Некорректный идентификатор аккаунта");
}
