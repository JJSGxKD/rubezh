import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { AccountSettingsService, type AccountSettingsView } from "./account-settings.service.js";

/**
 * Настройки аккаунта (`/api/v1/account/settings`, docs/35-stage4-plan.md WP29):
 * клиент читает их при входе и присылает изменённое. Изменения делает
 * человек переключателями — сотня в час честно, тысяча — уже скрипт.
 */
const LIMIT: RateLimit = { scope: "account-settings", limit: 300, windowSec: 3600 };

/**
 * Форма, а не смысл: схему каждого ключа проверяет каталог, лишнее он
 * пропускает. У записи либо возраст выбора, либо признак засева
 * (`account-settings.catalog.ts`).
 */
const entrySchema = z
  .object({ value: z.unknown(), ageMs: z.number().finite().nonnegative().optional(), seed: z.literal(true).optional() })
  .refine((entry) => (entry.ageMs === undefined) !== (entry.seed === undefined), { message: "либо возраст выбора, либо засев" });

const mergeSchema = z.object({
  version: z.number().int().min(1).max(1000),
  values: z.record(z.string().max(64), entrySchema).refine((values) => Object.keys(values).length <= 32, { message: "не больше 32 ключей" }),
});

@Controller("account/settings")
@UseGuards(AuthGuard)
export class AccountSettingsController {
  constructor(
    private readonly settings: AccountSettingsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async get(@Req() request: unknown): Promise<{ data: AccountSettingsView }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    return { data: await this.settings.get(account) };
  }

  @Post()
  async merge(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AccountSettingsView & { ignored: string[] } }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const parsed = mergeSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректные настройки");
    return { data: await this.settings.merge(account, parsed.data) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
