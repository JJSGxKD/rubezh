import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { runIdParamSchema } from "./dto/runs.dto.js";
import { RunGemContinueService, type GemContinueReceipt, type GemContinueView } from "./run-gem-continue.service.js";
import { RUNS_LIMITS } from "./runs-limits.js";

/**
 * Второй шанс за самоцветы (`/api/v1/runs/:runId/continues/gems`,
 * docs/35-stage4-plan.md Р162): цена и баланс для экрана смерти и сама
 * покупка. Только свой забег — аккаунт из токена. Границы запроса — те же, что
 * у покупки за звёзды (`payments/dto`): номер продолжения и секунда забега.
 */

/** Секунда забега в строке запроса: десятичное число без знака и порядка, не больше суток. */
const elapsedSecQuery = z
  .string()
  .regex(/^\d{1,5}(\.\d{1,6})?$/)
  .transform(Number)
  .pipe(z.number().min(0).max(86_400));

const viewQuerySchema = z.object({ elapsedSec: elapsedSecQuery });

const buySchema = z
  .object({
    continueNo: z.number().int().min(1).max(5),
    elapsedSec: z.number().min(0).max(86_400),
  })
  .strict();

@Controller("runs")
@UseGuards(AuthGuard)
export class RunGemContinueController {
  constructor(
    private readonly continues: RunGemContinueService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":runId/continues/gems")
  async view(@Req() request: unknown, @Param("runId") runId: string, @Query() query: unknown): Promise<{ data: GemContinueView }> {
    const { accountId } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    const parsed = viewQuerySchema.safeParse(query);
    if (!run.success || !parsed.success) throw new ValidationError("Некорректный забег или секунда");
    await this.limit(accountId);
    return { data: await this.continues.view(accountId, run.data, parsed.data.elapsedSec) };
  }

  @Post(":runId/continues/gems")
  @HttpCode(200)
  async buy(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: GemContinueReceipt }> {
    const { accountId } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    const parsed = buySchema.safeParse(body);
    if (!run.success || !parsed.success) throw new ValidationError("Некорректный забег или продолжение");
    await this.limit(accountId);
    return { data: await this.continues.buy(accountId, run.data, parsed.data) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(RUNS_LIMITS.gemContinue, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
