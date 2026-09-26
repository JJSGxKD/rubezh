import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { ShareService, type ShareResult } from "./share.service.js";

/**
 * «Поделиться» игрока (docs/24-attribution-and-sharing.md §7). Каждое нажатие
 * заводит ссылку — лимит частоты держит их число в разумных пределах.
 */
export const SHARE_LIMIT = { scope: "shares:create", limit: 30, windowSec: 3600 } as const;

const runShareSchema = z.object({ runId: z.string().min(1).max(64) }).strict();

@Controller("shares")
@UseGuards(AuthGuard)
export class ShareController {
  constructor(
    private readonly shares: ShareService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("run")
  async shareRun(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ShareResult }> {
    const account = accountOf(request);
    const parsed = runShareSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректный забег");
    if (!(await this.limiter.consume(SHARE_LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — подождите");
    return { data: await this.shares.shareRun(account, parsed.data.runId) };
  }
}
