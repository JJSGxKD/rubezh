import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { AdAudience, type AdNetworkSetup } from "./ad-audience.js";
import type { AdRequester } from "./ad-creatives.js";
import { AD_DEVICES, AD_PLACES } from "./ads-rules.js";
import type { AdOutcome } from "./ads.repository.js";
import { AdsService, type AdOffer } from "./ads.service.js";
import { InterstitialGate } from "./interstitial-gate.js";
import { INTERSTITIAL_MOMENTS } from "./interstitial-policy.js";

/**
 * Реклама (`/api/v1/ads`, docs/35-stage4-plan.md §3.7, WP12): выдать показ
 * в месте и записать шаги воронки. Только своё — аккаунт из токена. Награды
 * здесь нет: её выдаёт хозяин места, забирая выполненную сессию.
 *
 * Лимит выдач держит и историю места честной: сотни пустых выдач за час не
 * набрать (`ads.repository.ts`, окно истории).
 */
const OFFER_LIMIT: RateLimit = { scope: "ads_offer", limit: 120, windowSec: 3600 };
/**
 * Межстраничную спрашивает каждый старт забега — своим лимитом: игрок,
 * который часто перезапускает забег, не должен остаться без колеса и
 * удвоения. Шестьдесят стартов в час — забег короче минуты подряд.
 */
const INTERSTITIAL_LIMIT: RateLimit = { scope: "ads_interstitial", limit: 60, windowSec: 3600 };
const REPORT_LIMIT: RateLimit = { scope: "ads_report", limit: 600, windowSec: 3600 };

/**
 * Язык и премиум — со слов клиента площадки: их ждёт сеть с API для
 * таргетинга (Р78). Солгать о них — значит лишь получить чужую рекламу:
 * на выдачу и награду они не влияют.
 *
 * `moment` — когда клиент просит межстраничную (WP12 ч.10): без него её не
 * выдать, у других мест его нет. Солгать о моменте нельзя с выгодой —
 * политика площадки решает по нему лишь «показывать или нет».
 */
const offerSchema = z
  .object({
    place: z.enum(AD_PLACES),
    device: z.enum(AD_DEVICES).optional(),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})?$/)
      .optional(),
    premium: z.boolean().optional(),
    moment: z.enum(INTERSTITIAL_MOMENTS).optional(),
  })
  .strict()
  .refine((body) => (body.place === "interstitial") === (body.moment !== undefined), { message: "момент — только у межстраничной и обязательно" });

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
    private readonly audience: AdAudience,
    private readonly interstitials: InterstitialGate,
  ) {}

  /**
   * Реклама на запуске. Сети, чей SDK клиент поднимает для учёта аудитории
   * (Р78), — у каждого игрока их площадки, включена сеть или нет; ключи
   * публичные — их всё равно видно в коде клиента; ответ — из запаса в
   * памяти. `interstitial` — ждать ли межстраничную при старте забега
   * (WP12 ч.10): вне доли выката клиент её не спрашивает вовсе.
   */
  @Get("networks")
  async networks(@Req() request: unknown): Promise<{ data: { networks: AdNetworkSetup[]; interstitial: boolean } }> {
    const { accountId, platform } = accountOf(request);
    const [networks, interstitial] = await Promise.all([this.audience.launchSetup(platform), this.interstitials.expected({ accountId, platform }, new Date())]);
    return { data: { networks, interstitial } };
  }

  @Post("sessions")
  @HttpCode(200)
  async offer(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AdOffer }> {
    const { accountId, platform, platformUserId } = accountOf(request);
    const parsed = offerSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Неизвестное место или момент показа");
    await this.limit(parsed.data.place === "interstitial" ? INTERSTITIAL_LIMIT : OFFER_LIMIT, accountId);
    const requester = requesterOf(request, platformUserId, parsed.data.language ?? null, parsed.data.premium ?? null);
    const viewer = { accountId, platform, device: parsed.data.device ?? null, requester };
    return { data: await this.ads.offer(viewer, parsed.data.place, new Date(), parsed.data.moment) };
  }

  @Post("sessions/:sessionId/result")
  @HttpCode(200)
  async report(@Req() request: unknown, @Param("sessionId") sessionId: string, @Body() body: unknown): Promise<{ data: { ok: true } }> {
    const { accountId, platformUserId } = accountOf(request);
    const parsed = reportSchema.safeParse(body);
    if (!sessionIdSchema.safeParse(sessionId).success || !parsed.success) throw new ValidationError("Неизвестный показ или его исход");
    await this.limit(REPORT_LIMIT, accountId);
    await this.ads.report(accountId, sessionId, outcomeOf(parsed.data), new Date(), requesterOf(request, platformUserId, null, null));
    return { data: { ok: true } };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}

/**
 * Игрок для сети с API: адрес — из `req.ip` Fastify с учётом доверенных
 * прокси, а не из сырого заголовка, который подделывается одной строкой.
 */
function requesterOf(request: unknown, platformUserId: string, language: string | null, premium: boolean | null): AdRequester {
  const { ip, headers } = request as { ip?: unknown; headers?: Record<string, unknown> };
  const agent = headers?.["user-agent"];
  return {
    platformUserId,
    ip: typeof ip === "string" && ip !== "" ? ip : null,
    userAgent: typeof agent === "string" && agent !== "" ? agent.slice(0, 512) : null,
    language,
    premium,
  };
}

function outcomeOf(report: z.infer<typeof reportSchema>): AdOutcome {
  return report.outcome === "failed" ? { kind: "failed", reason: report.reason } : { kind: report.outcome };
}
