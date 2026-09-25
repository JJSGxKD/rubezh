import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { walletAdjustSchema, walletLookupSchema } from "./dto/wallet.dto.js";
import { WALLET_LIMITS } from "./wallet-limits.js";
import type { WalletEntryRow } from "./wallet.repository.js";
import { WalletService, type AdjustResult } from "./wallet.service.js";
import type { Balances } from "./wallet-types.js";

/**
 * Кошелёк (docs/35-stage4-plan.md, WP3). Игроку — только чтение своего;
 * панели — чужой кошелёк с журналом и ручная операция под отдельным правом.
 * Логики здесь нет — разбор границы и форма ответа.
 */
@Controller("wallet")
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly limiter: RateLimiter,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
  ) {}

  @Get()
  async mine(@Req() request: unknown): Promise<{ data: { balances: Balances } }> {
    const account = accountOf(request);
    await this.limit(WALLET_LIMITS.read, account.accountId);
    return { data: { balances: await this.wallet.balances(account.accountId) } };
  }

  /** Кошелёк игрока и последние строки журнала — разбор жалобы «пропали монеты». */
  @Get("admin")
  @UseGuards(PermissionGuard)
  @RequirePermission("players.view")
  async inspect(@Query() query: unknown): Promise<{ data: { accountId: string; balances: Balances; entries: WalletEntryRow[] } }> {
    const lookup = parse(() => walletLookupSchema.parse(query), "Некорректный запрос кошелька");
    const accountId = await this.resolve(lookup);
    const [balances, entries] = await Promise.all([this.wallet.balances(accountId), this.wallet.recentEntries(accountId, lookup.limit)]);
    return { data: { accountId, balances, entries } };
  }

  @Post("admin/adjust")
  @UseGuards(PermissionGuard)
  @RequirePermission("players.wallet.adjust")
  async adjust(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AdjustResult }> {
    const actor = accountOf(request);
    await this.limit(WALLET_LIMITS.adjust, actor.accountId);
    const adjust = parse(() => walletAdjustSchema.parse(body), "Некорректная операция");
    const accountId = await this.resolve(adjust);
    return {
      data: await this.wallet.adjust(actor, {
        accountId,
        resource: adjust.resource,
        delta: adjust.delta,
        note: adjust.note,
        idempotencyKey: adjust.idempotencyKey,
      }),
    };
  }

  private async resolve(target: { accountId?: string | undefined; platformUserId?: string | undefined; platform: PlatformId }): Promise<string> {
    if (target.accountId !== undefined) return target.accountId;
    const account = await this.accounts.byPlatformUser(target.platform, target.platformUserId ?? "");
    if (account === null) throw new ValidationError("Аккаунт не найден");
    return account.accountId;
  }

  private async limit(rule: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
