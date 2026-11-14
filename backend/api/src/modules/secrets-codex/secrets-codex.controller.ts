import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { SecretsCodexService, type SecretsCodexView } from "./secrets-codex.service.js";

/**
 * Кодекс тайников (`/api/v1/codex/secrets`, tasks/T-0261): какие виды игрок
 * находил за всё время. Только своё — аккаунт из токена. Награда — достижение
 * «Следопыт» в общей витрине достижений, отдельного забора здесь нет.
 *
 * Лимит — по аккаунту, как у кодекса врагов: вкладку открывают при каждом
 * заходе в гайдбук, а за адресом мобильного оператора стоят сотни игроков.
 */
const LIMIT: RateLimit = { scope: "secrets-codex", limit: 300, windowSec: 3600 };

@Controller("codex/secrets")
@UseGuards(AuthGuard)
export class SecretsCodexController {
  constructor(
    private readonly codex: SecretsCodexService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: SecretsCodexView }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    return { data: await this.codex.view(account.accountId) };
  }
}
