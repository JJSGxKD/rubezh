import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError, type ZodType } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { boostActivateSchema, boostRefundSchema } from "./dto/boosts.dto.js";
import { BOOST_LIMITS } from "./boosts-limits.js";
import { BoostsService, type ActivationView, type BoostCatalogView } from "./boosts.service.js";

/**
 * Бусты игрока (docs/35-stage4-plan.md §3.5, Р39). Логики здесь нет — разбор
 * границы и форма ответа.
 */
@Controller("boosts")
@UseGuards(AuthGuard)
export class BoostsController {
  constructor(
    private readonly boosts: BoostsService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Каталог с ценами — экран выбора перед забегом. Цены знает только сервер. */
  @Get()
  async catalog(@Req() request: unknown): Promise<{ data: BoostCatalogView }> {
    await this.limit(BOOST_LIMITS.read, request);
    return { data: this.boosts.catalog() };
  }

  @Post("activate")
  async activate(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ActivationView }> {
    const accountId = await this.limit(BOOST_LIMITS.write, request);
    const input = parse(boostActivateSchema, body, "Некорректная покупка бустов");
    return { data: await this.boosts.activate(accountId, input.runId, input.boosts) };
  }

  @Post("refund")
  async refund(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { refunded: boolean } }> {
    const accountId = await this.limit(BOOST_LIMITS.write, request);
    const input = parse(boostRefundSchema, body, "Некорректный возврат");
    return { data: await this.boosts.refund(accountId, input.runId) };
  }

  private async limit(rule: RateLimit, request: unknown): Promise<string> {
    const { accountId } = accountOf(request);
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return accountId;
  }
}

function parse<T>(schema: ZodType<T>, value: unknown, message: string): T {
  try {
    return schema.parse(value);
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
