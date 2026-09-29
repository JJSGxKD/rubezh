import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { HISTORY_CATEGORIES } from "./history-types.js";
import { HISTORY_PAGE_MAX, HistoryService, type HistoryView } from "./history.service.js";

/**
 * История имущества игрока (`/api/v1/me/history`, docs/35-stage4-plan.md
 * §3.17): фильтр по категориям и курсор. Только своё: аккаунт из токена.
 */
const LIMIT: RateLimit = { scope: "history", limit: 300, windowSec: 3600 };

const querySchema = z.object({
  /** категории через запятую; не заданы — все */
  categories: z
    .string()
    .max(80)
    .optional()
    .transform((value) => (value === undefined || value === "" ? [...HISTORY_CATEGORIES] : value.split(",")))
    .pipe(z.array(z.enum(HISTORY_CATEGORIES)).min(1).max(HISTORY_CATEGORIES.length)),
  cursor: z.string().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
});

@Controller("me/history")
@UseGuards(AuthGuard)
export class HistoryController {
  constructor(
    private readonly history: HistoryService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown, @Query() query: unknown): Promise<{ data: HistoryView }> {
    const { accountId } = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError("Некорректный запрос истории");
    return { data: await this.history.history(accountId, [...new Set(parsed.data.categories)], parsed.data.cursor, parsed.data.limit) };
  }
}
