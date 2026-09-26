import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError, type ZodType } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { itemIdSchema, itemMergeSchema, itemOperationSchema, itemRerollSchema } from "./dto/items.dto.js";
import type { LoadoutSnapshot } from "./item-loadout.js";
import type { InventoryView, ItemView } from "./item-views.js";
import { ITEM_LIMITS } from "./items-limits.js";
import { ItemsService } from "./items.service.js";

/**
 * Снаряжение игрока (docs/35-stage4-plan.md §3.4, WP7): только своё — чужой
 * предмет неотличим от несуществующего. Логики здесь нет — разбор границы и
 * форма ответа.
 */
@Controller("items")
@UseGuards(AuthGuard)
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async inventory(@Req() request: unknown): Promise<{ data: InventoryView }> {
    const accountId = await this.reader(request);
    return { data: await this.items.inventory(accountId) };
  }

  /** Подписанный снимок надетого — клиент берёт его с собой в забег. */
  @Get("loadout")
  async loadout(@Req() request: unknown): Promise<{ data: LoadoutSnapshot }> {
    const accountId = await this.reader(request);
    return { data: await this.items.loadout(accountId) };
  }

  @Post("merge")
  async merge(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ItemView }> {
    const accountId = await this.writer(request);
    const merge = parse(itemMergeSchema, body, "Некорректное объединение");
    return { data: await this.items.merge(accountId, merge.itemIds, merge.idempotencyKey) };
  }

  @Post(":itemId/equip")
  async equip(@Req() request: unknown, @Param("itemId") itemId: string): Promise<{ data: ItemView }> {
    const accountId = await this.writer(request);
    return { data: await this.items.equip(accountId, parse(itemIdSchema, itemId, "Некорректный предмет")) };
  }

  @Post(":itemId/unequip")
  async unequip(@Req() request: unknown, @Param("itemId") itemId: string): Promise<{ data: ItemView }> {
    const accountId = await this.writer(request);
    return { data: await this.items.unequip(accountId, parse(itemIdSchema, itemId, "Некорректный предмет")) };
  }

  @Post(":itemId/upgrade")
  async upgrade(@Req() request: unknown, @Param("itemId") itemId: string, @Body() body: unknown): Promise<{ data: ItemView }> {
    const accountId = await this.writer(request);
    const operation = parse(itemOperationSchema, body, "Некорректное улучшение");
    return { data: await this.items.upgrade(accountId, parse(itemIdSchema, itemId, "Некорректный предмет"), operation.idempotencyKey) };
  }

  @Post(":itemId/reroll")
  async reroll(@Req() request: unknown, @Param("itemId") itemId: string, @Body() body: unknown): Promise<{ data: ItemView }> {
    const accountId = await this.writer(request);
    const reroll = parse(itemRerollSchema, body, "Некорректная перековка");
    return { data: await this.items.reroll(accountId, parse(itemIdSchema, itemId, "Некорректный предмет"), reroll.index, reroll.idempotencyKey) };
  }

  @Post(":itemId/salvage")
  async salvage(
    @Req() request: unknown,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
  ): Promise<{ data: { shards: number; resource: WalletResource } }> {
    const accountId = await this.writer(request);
    const operation = parse(itemOperationSchema, body, "Некорректный разбор");
    return { data: await this.items.salvage(accountId, parse(itemIdSchema, itemId, "Некорректный предмет"), operation.idempotencyKey) };
  }

  private async reader(request: unknown): Promise<string> {
    return await this.limit(ITEM_LIMITS.read, request);
  }

  private async writer(request: unknown): Promise<string> {
    return await this.limit(ITEM_LIMITS.write, request);
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
