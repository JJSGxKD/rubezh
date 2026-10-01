import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SHOP_SKUS, skuById, type ShopKind } from "./shop-catalog.js";
import { PromoNotFoundError, PromoOverlapError, PromoPeriodError, ShopSkuNotFoundError } from "./shop-errors.js";
import { PROMO_LIMITS, promoProblem, promoState, type PromoInput, type PromoRow, type PromoState } from "./shop-promo-rules.js";
import { SHOP_PROMO_REPOSITORY, type ShopPromoRepository } from "./shop-promo.repository.js";

/**
 * Акции магазина (docs/35-stage4-plan.md WP10, часть 8): заводит и снимает
 * команда в панели под `shop.promo.edit`, каждое действие — в аудит; витрина
 * и счёт берут идущие акции отсюда.
 *
 * Идущие акции живут в памяти реплики полминуты, как каталог заданий: витрину
 * открывают часто, а акции меняются раз в недели. Акция, которая начнётся в
 * эти полминуты, попадает в выборку заранее и начинается вовремя; снятая
 * видна на других репликах до полуминуты — в пользу игрока, и это допустимо.
 */

export interface PromoAdminRow extends PromoRow {
  state: PromoState;
}

export interface PromoCatalogView {
  promos: PromoAdminRow[];
  /** товары, на которые можно завести акцию, с ценой каталога в звёздах — для предпросмотра скидки */
  skus: { sku: string; title: string; kind: ShopKind; stars: number }[];
  limits: typeof PROMO_LIMITS;
}

const CACHE_TTL_MS = 30_000;
const DB_TIMEOUT_MS = 3_000;
/** панели хватает: акций у товара — не больше двух в месяц */
const LIST_LIMIT = 200;

@Injectable()
export class ShopPromoService {
  private readonly logger = new Logger("shop");
  private cache: { promos: PromoRow[]; until: number } | null = null;

  constructor(
    @Inject(SHOP_PROMO_REPOSITORY) private readonly repository: ShopPromoRepository,
    private readonly roles: RolesService,
  ) {}

  /** Идущие сейчас акции по товарам. У товара их не бывает две: это держат правила. */
  async active(at = new Date()): Promise<ReadonlyMap<string, PromoRow>> {
    const now = at.getTime();
    if (this.cache === null || this.cache.until <= now) {
      const promos = await this.db(this.repository.current(at, new Date(now + CACHE_TTL_MS)));
      this.cache = { promos, until: now + CACHE_TTL_MS };
    }
    return new Map(this.cache.promos.filter((promo) => promo.startsAt <= at && at < promo.endsAt).map((promo) => [promo.sku, promo]));
  }

  async catalog(actor: AccountRef, at = new Date()): Promise<PromoCatalogView> {
    await this.roles.require(actor, "shop.promo.edit");
    const promos = await this.db(this.repository.list(LIST_LIMIT));
    return {
      promos: promos.map((promo) => ({ ...promo, state: promoState(promo, at) })),
      skus: [...SHOP_SKUS].sort((a, b) => a.sort - b.sort).map((sku) => ({ sku: sku.id, title: sku.title, kind: sku.kind, stars: sku.stars })),
      limits: PROMO_LIMITS,
    };
  }

  async create(actor: AccountRef, input: PromoInput, at = new Date()): Promise<PromoAdminRow> {
    await this.roles.require(actor, "shop.promo.edit");
    if (skuById(input.sku) === undefined) throw new ShopSkuNotFoundError();
    const promo = { ...input, promoId: randomUUID(), createdBy: actor.accountId };
    const problem = await this.db(this.repository.create(promo, at, (nearby) => promoProblem(input, nearby, at)));
    if (problem !== null) throw problem.code === "promo_overlap" ? new PromoOverlapError(problem.message) : new PromoPeriodError(problem.message);
    const row: PromoRow = { ...promo, createdAt: at, cancelledAt: null, cancelledBy: null };
    await this.roles.audit({ actorAccountId: actor.accountId, action: "shop.promo.create", target: promo.promoId, after: row });
    this.cache = null;
    this.log("promo_created", { promoId: promo.promoId, sku: promo.sku, percent: promo.percent, startsAt: promo.startsAt, endsAt: promo.endsAt, actor: actor.accountId });
    return { ...row, state: promoState(row, at) };
  }

  async cancel(actor: AccountRef, promoId: string, at = new Date()): Promise<PromoAdminRow> {
    await this.roles.require(actor, "shop.promo.edit");
    const row = await this.db(this.repository.cancel(promoId, actor.accountId, at));
    if (row === null) throw new PromoNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "shop.promo.cancel", target: promoId, after: row });
    this.cache = null;
    this.log("promo_cancelled", { promoId, sku: row.sku, actor: actor.accountId });
    return { ...row, state: promoState(row, at) };
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "акции магазина");
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "shop", event, ...fields }));
  }
}
