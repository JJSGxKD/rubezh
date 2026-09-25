import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { WalletService, type AdjustResult } from "../wallet/wallet.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminPlayersService, type BanResult, type PlayerCard, type PlayerRow } from "./admin-players.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { accountIdSchema, adminWalletAdjustSchema, banSchema, playerSearchSchema } from "./dto/admin.dto.js";

/**
 * Игроки в панели (docs/29-admin-panel.md §2). Логики нет — разбор границы,
 * лимит и форма ответа; права — на каждом маршруте, закрыто по умолчанию.
 */
@Controller("admin/players")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPlayersController {
  constructor(
    private readonly players: AdminPlayersService,
    private readonly wallet: WalletService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("players.view")
  async search(@Req() request: unknown, @Query() query: unknown): Promise<{ data: { players: PlayerRow[] } }> {
    const search = parse(() => playerSearchSchema.parse(query), "Некорректный запрос поиска");
    return { data: { players: await this.players.search(accountOf(request), search.query, search.limit) } };
  }

  @Get(":accountId")
  @RequirePermission("players.view")
  async card(@Req() request: unknown, @Param("accountId") accountId: string): Promise<{ data: PlayerCard }> {
    return { data: await this.players.card(accountOf(request), parseAccountId(accountId)) };
  }

  @Post(":accountId/ban")
  @RequirePermission("players.ban")
  async ban(@Req() request: unknown, @Param("accountId") accountId: string, @Body() body: unknown): Promise<{ data: BanResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { reason } = parse(() => banSchema.parse(body), "Нужна причина блокировки");
    return { data: await this.players.ban(actor, parseAccountId(accountId), reason) };
  }

  @Post(":accountId/unban")
  @RequirePermission("players.ban")
  async unban(@Req() request: unknown, @Param("accountId") accountId: string): Promise<{ data: BanResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.players.unban(actor, parseAccountId(accountId)) };
  }

  /** Ручное начисление и списание — право, причина, ключ кнопки и аудит проверяет сам кошелёк. */
  @Post(":accountId/wallet/adjust")
  @RequirePermission("players.wallet.adjust")
  async adjust(@Req() request: unknown, @Param("accountId") accountId: string, @Body() body: unknown): Promise<{ data: AdjustResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const adjust = parse(() => adminWalletAdjustSchema.parse(body), "Некорректная операция с кошельком");
    return { data: await this.wallet.adjust(actor, { accountId: parseAccountId(accountId), ...adjust }) };
  }

  private async limit(actorId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actorId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

function parseAccountId(value: string): string {
  return parse(() => accountIdSchema.parse(value), "Некорректный идентификатор аккаунта");
}
