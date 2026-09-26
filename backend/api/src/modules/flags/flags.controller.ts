import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { FlagsService } from "./flags.service.js";

/** Клиент спрашивает флаги после входа и при возврате в приложение — триста в час хватит с запасом. */
export const READ_LIMIT = { scope: "flags:read", limit: 300, windowSec: 3600 } as const;

/** Флаги игрока — клиент спрашивает после входа и прячет выключенное. Решает всё равно сервер. */
@Controller("flags")
@UseGuards(AuthGuard)
export class FlagsController {
  constructor(
    private readonly flags: FlagsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async mine(@Req() request: unknown): Promise<{ data: { flags: Record<string, boolean> } }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(READ_LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — подождите");
    return { data: { flags: await this.flags.forAccount(account) } };
  }
}
