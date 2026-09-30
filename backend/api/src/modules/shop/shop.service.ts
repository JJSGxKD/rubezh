import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { methodFor, priceIn } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import type { StoredPurchase } from "../payments/purchase-types.js";
import type { AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { ShopSkuNotFoundError, ShopSkuUnavailableError } from "./shop-errors.js";
import { SHOP_SKUS, contentsOf, priceProduct, skuById, type ShopKind, type ShopResource } from "./shop-catalog.js";

/**
 * Магазин (docs/35-stage4-plan.md §3.6, WP10): витрина с ценой способа оплаты
 * площадки игрока, счёт на товар и выдача после подтверждения оплаты.
 *
 * Оплату ведёт модуль оплаты — цепочка второго шанса, обобщённая на товары;
 * магазин решает, что продаётся и почём, и кладёт оплаченное на счёт игрока
 * журналом кошелька с ключом покупки. Выдачу зовёт задание подтверждения
 * оплаты, и повтор ничего не удваивает.
 */

export interface ShopItemView {
  sku: string;
  kind: ShopKind;
  contents: { resource: ShopResource; amount: number }[];
  /** цена в звёздах; `null` — на этой площадке способа оплаты нет */
  stars: number | null;
  once: boolean;
  /** разовый товар уже куплен */
  owned: boolean;
}

export interface ShopView {
  items: ShopItemView[];
  /** на площадке игрока есть способ оплаты */
  payable: boolean;
}

@Injectable()
export class ShopService implements OnModuleInit {
  private readonly logger = new Logger("shop");

  constructor(
    private readonly payments: PaymentsService,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly wallet: WalletService,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("shop_item", (purchase) => this.fulfill(purchase));
  }

  async view(account: AccountRef): Promise<ShopView> {
    const skus = [...SHOP_SKUS].sort((a, b) => a.sort - b.sort);
    const owned = await this.payments.ownedOnce(
      account,
      skus.filter((sku) => sku.once).map((sku) => sku.id),
    );
    const method = methodFor(account.platform);
    return {
      payable: method !== undefined,
      items: skus.map((sku) => ({
        sku: sku.id,
        kind: sku.kind,
        contents: contentsOf(sku),
        stars: method === undefined ? null : priceIn(priceProduct(sku), method),
        once: sku.once,
        owned: owned.has(sku.id),
      })),
    };
  }

  async order(account: AccountRef, skuId: string): Promise<ShopInvoice> {
    const sku = skuById(skuId);
    if (sku === undefined) throw new ShopSkuNotFoundError();
    const method = methodFor(account.platform);
    if (method === undefined) throw new PaymentsUnsupportedError();
    const stars = priceIn(priceProduct(sku), method);
    if (stars === null) throw new ShopSkuUnavailableError();
    const invoice = await this.payments.shopInvoice(account, { sku: sku.id, priceStars: stars, once: sku.once, text: { title: sku.title, description: sku.description } });
    this.log("shop_order", { accountId: account.accountId, sku: sku.id, purchaseId: invoice.purchaseId, status: invoice.status });
    return invoice;
  }

  /**
   * Выдача оплаченного — состав товара, каждым ресурсом отдельно, ключом
   * покупки. Товара нет в каталоге — не выдаём наугад: задание повторится,
   * а потом уйдёт в лог человеку. Поэтому товар с витрины не удаляют, пока по
   * нему могут прийти оплаты открытых счетов (`INVOICE_TTL_SEC`).
   */
  async fulfill(purchase: StoredPurchase): Promise<void> {
    const sku = purchase.sku === null ? undefined : skuById(purchase.sku);
    if (sku === undefined) throw new Error(`товара ${purchase.sku ?? "—"} нет в каталоге — выдавать нечего`);
    for (const { resource, amount } of contentsOf(sku)) {
      await this.wallet.grant({
        accountId: purchase.accountId,
        resource,
        amount,
        reason: "purchase",
        source: `shop:${sku.id}`,
        idempotencyKey: `purchase:${purchase.purchaseId}:${resource}`,
      });
    }
    this.log("shop_fulfilled", { accountId: purchase.accountId, sku: sku.id, purchaseId: purchase.purchaseId, mode: purchase.mode });
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "shop", event, ...fields }));
  }
}
