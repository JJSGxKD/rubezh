import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { AD_DEVICES, AD_PLACES } from "./ads-rules.js";
import type { AdOutcome } from "./ads.repository.js";
import { AdsService, type AdOffer } from "./ads.service.js";

/**
 * Реклама (`/api/v1/ads`, docs/35-stage4-plan.md §3.7, WP12): выдать показ
 * в месте и записать шаги воронки. Только своё — аккаунт из токена. Награды
 * здесь нет: её выдаёт хозяин места, забирая выполненную сессию.
 *
 * Лимит выдач держит и историю места честной: сотни пустых выдач за час не
 * набрать (`ads.repository.ts`, окно истории).
 */
const OFFER_LIMIT: RateLimit = { scope: "ads_offer", limit: 120, windowSec: 3600 };
const REPORT_LIMIT: RateLimit = { scope: "ads_report", limit: 600, windowSec: 3600 };

const offerSchema = z.object({ place: z.enum(AD_PLACES), device: z.enum(AD_DEVICES).optional() }).strict();

/** Идентификатор сессии — 12 случайных байт в base64url. */
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);

/** Код отказа SDK — для разреза в воронке, без текста ошибки и данных игрока. */
const reportSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("shown") }).strict(),
  z.object({ outcome: z.literal("completed") }).strict(),
  z.object({ outcome: z.literal("clicked") }).strict(),
  z.object({ outcome: z.literal("failed"), reason: z.string().regex(/^[a-z0-9_.:-]{1,64}$/) }).strict(),
]);

@Controller("ads")
@UseGuards(AuthGuard)
export class AdsController {
  constructor(
    private readonly ads: AdsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("sessions")
  @HttpCode(200)
  async offer(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AdOffer }> {
    const { accountId, platform } = accountOf(request);
    const parsed = offerSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Неизвестное место показа");
    await this.limit(OFFER_LIMIT, accountId);
    return { data: await this.ads.offer({ accountId, platform, device: parsed.data.device ?? null }, parsed.data.place) };
  }

  @Post("sessions/:sessionId/result")
  @HttpCode(200)
  async report(@Req() request: unknown, @Param("sessionId") sessionId: string, @Body() body: unknown): Promise<{ data: { ok: true } }> {
    const { accountId } = accountOf(request);
    const parsed = reportSchema.safeParse(body);
    if (!sessionIdSchema.safeParse(sessionId).success || !parsed.success) throw new ValidationError("Неизвестный показ или его исход");
    await this.limit(REPORT_LIMIT, accountId);
    await this.ads.report(accountId, sessionId, outcomeOf(parsed.data));
    return { data: { ok: true } };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}

function outcomeOf(report: z.infer<typeof reportSchema>): AdOutcome {
  return report.outcome === "failed" ? { kind: "failed", reason: report.reason } : { kind: report.outcome };
}
