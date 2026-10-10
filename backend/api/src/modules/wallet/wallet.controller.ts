import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { WALLET_LIMITS } from "./wallet-limits.js";
import { WalletService } from "./wallet.service.js";
import type { Balances } from "./wallet-types.js";

/**
 * Кошелёк игрока — только чтение своего. Чужой кошелёк и ручные операции — в
 * панели (`admin-players.controller.ts`). Логики здесь нет — разбор границы и
 * форма ответа (docs/35-stage4-plan.md, WP3).
 */
@Controller("wallet")
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async mine(@Req() request: unknown): Promise<{ data: { balances: Balances } }> {
    const account = accountOf(request);
    await this.limit(WALLET_LIMITS.read, account.accountId);
    return { data: { balances: await this.wallet.balances(account.accountId) } };
  }

  private async limit(rule: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
