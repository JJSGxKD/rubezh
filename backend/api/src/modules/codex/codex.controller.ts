import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { CodexService, type CodexView } from "./codex.service.js";

/**
 * Кодекс врагов (`/api/v1/codex`, tasks/T-0127): какие записи открыты, процент и
 * награда за полный кодекс. Только своё — аккаунт из токена. Забор награды —
 * прежний `POST /tasks/:id/claim`: награда кодекса — достижение каталога.
 *
 * Лимит — по аккаунту, как у заданий: вкладку «Враги» открывают при каждом
 * заходе в гайдбук, а за адресом мобильного оператора стоят сотни игроков.
 */
const LIMIT: RateLimit = { scope: "codex", limit: 300, windowSec: 3600 };

@Controller("codex")
@UseGuards(AuthGuard)
export class CodexController {
  constructor(
    private readonly codex: CodexService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: CodexView }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    return { data: await this.codex.view(account) };
  }
}
