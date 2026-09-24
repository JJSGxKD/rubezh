import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { continueRequestSchema, purchaseIdSchema } from "./dto/payments.dto.js";
import { PAYMENTS_LIMITS } from "./payments-limits.js";
import { PaymentsService, type ContinueInvoice, type ContinueOffer, type PurchaseView } from "./payments.service.js";

/**
 * Оплата второго шанса (docs/34-stage3-plan.md, WP5). В контроллере нет
 * логики — только разбор границы и форма ответа
 * (docs/15-engineering-standards.md §2.3). Всё под `AuthGuard`: покупка
 * принадлежит аккаунту.
 */
@Controller("payments")
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("continue/quote")
  async quote(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ContinueOffer }> {
    const account = accountOf(request);
    await this.limit(PAYMENTS_LIMITS.quote, account.accountId);
    const parsed = parse(() => continueRequestSchema.parse(body), "Некорректный запрос цены");
    return { data: await this.payments.quote(account, parsed) };
  }

  @Post("continue/invoice")
  async invoice(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ContinueInvoice }> {
    const account = accountOf(request);
    await this.limit(PAYMENTS_LIMITS.invoice, account.accountId);
    const parsed = parse(() => continueRequestSchema.parse(body), "Некорректный запрос счёта");
    return { data: await this.payments.invoice(account, parsed) };
  }

  @Get(":purchaseId")
  async purchase(@Req() request: unknown, @Param("purchaseId") purchaseId: string): Promise<{ data: PurchaseView }> {
    const account = accountOf(request);
    await this.limit(PAYMENTS_LIMITS.status, account.accountId);
    const parsed = parse(() => purchaseIdSchema.parse(purchaseId), "Некорректная покупка");
    return { data: await this.payments.purchase(account, parsed) };
  }

  private async limit(rule: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком много запросов оплаты — подождите");
  }
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
