import { priceFor, type RatesSnapshot } from "@bh/fx";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import type { StoredPurchase } from "../payments/purchase-types.js";
import type { AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { ShopSkuNotFoundError, ShopSkuUnavailableError } from "./shop-errors.js";
import { PAYMENT_METHODS, SHOP_SKUS, contentsOf, priceProduct, skuById, type ShopKind, type ShopResource, type ShopSku } from "./shop-catalog.js";

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

/**
 * Ручная цена курсов не требует — снимок для неё пустой. Товар без ручной
 * цены у способа при пустом снимке честно недоступен, а не стоит ноль.
 */
const NO_RATES: RatesSnapshot = { id: "manual-only", takenAt: new Date(0), rates: new Map(), payout: new Map() };

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
    const method = methodFor(account);
    return {
      payable: method !== undefined,
      items: skus.map((sku) => ({
        sku: sku.id,
        kind: sku.kind,
        contents: contentsOf(sku),
        stars: method === undefined ? null : starsOf(sku, method.id),
        once: sku.once,
        owned: owned.has(sku.id),
      })),
    };
  }

  async order(account: AccountRef, skuId: string): Promise<ShopInvoice> {
    const sku = skuById(skuId);
    if (sku === undefined) throw new ShopSkuNotFoundError();
    const method = methodFor(account);
    if (method === undefined) throw new PaymentsUnsupportedError();
    const stars = starsOf(sku, method.id);
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

function methodFor(account: AccountRef): (typeof PAYMENT_METHODS)[number] | undefined {
  return [...PAYMENT_METHODS].sort((a, b) => a.order - b.order).find((method) => method.platform === account.platform);
}

/** Цена товара способом оплаты в звёздах; `null` — способ этот товар не продаёт. */
function starsOf(sku: ShopSku, methodId: string): number | null {
  const method = PAYMENT_METHODS.find((candidate) => candidate.id === methodId);
  if (method === undefined) return null;
  const price = priceFor(priceProduct(sku), method, NO_RATES);
  return price.status === "available" ? price.amount.toNumber() : null;
}
