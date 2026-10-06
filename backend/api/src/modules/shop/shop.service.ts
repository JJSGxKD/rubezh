import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ItemsService } from "../items/items.service.js";
import { methodFor, priceIn } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import type { PaymentMode, StoredPurchase } from "../payments/purchase-types.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { badgesOf, gemValuePct, recommendedSku, type ShopBadge } from "./shop-marketing.js";
import { ShopSkuNotFoundError, ShopSkuUnavailableError } from "./shop-errors.js";
import { promoOffer, type PromoRow } from "./shop-promo-rules.js";
import { ShopPromoService } from "./shop-promo.service.js";
import { SHOP_SKUS, contentsOf, priceProduct, skuById, type ShopKind, type ShopResource, type ShopSku } from "./shop-catalog.js";

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
  /** цена в звёздах, по акции — со скидкой; `null` — на этой площадке способа оплаты нет */
  stars: number | null;
  /** цена каталога до скидки — её зачёркивают; `null` — акции на товар нет */
  fullStars: number | null;
  /** идущая акция: скидка фактическая, с округлением вниз (`shop-promo-rules.ts`) */
  promo: ShopPromoView | null;
  /** сколько спишется на самом деле: в тестовом режиме — звезда (Р14) */
  chargedStars: number | null;
  once: boolean;
  /** разовый товар уже куплен */
  owned: boolean;
  /** «Хит» — от команды, «Лучшая цена» — у самого выгодного набора самоцветов */
  badge: ShopBadge | null;
  /** на сколько процентов самоцвет здесь дешевле, чем в самом дорогом наборе; `null` — не набор самоцветов или это он и есть */
  valuePct: number | null;
}

export interface ShopPromoView {
  percent: number;
  endsAt: Date;
  /** подпись баннера от команды; `null` — текст по товару и скидке */
  title: string | null;
}

export interface ShopView {
  items: ShopItemView[];
  /** на площадке игрока есть способ оплаты */
  payable: boolean;
  /** тестовая оплата — витрина предупреждает, что звезда вернётся */
  mode: PaymentMode;
  /** товар, который предложить игроку первым, — под него (`shop-marketing.ts`); `null` — нечего */
  recommended: string | null;
  /** ссылка на покупку звёзд через Tribute — плашка у самоцветов; `null` — не задана или не Telegram */
  tribute: string | null;
}

const DB_TIMEOUT_MS = 3_000;

@Injectable()
export class ShopService implements OnModuleInit {
  private readonly logger = new Logger("shop");

  constructor(
    private readonly payments: PaymentsService,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly wallet: WalletService,
    private readonly items: ItemsService,
    private readonly promos: ShopPromoService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("shop_item", (purchase) => this.fulfill(purchase));
  }

  async view(account: AccountRef, at = new Date()): Promise<ShopView> {
    const skus = [...SHOP_SKUS].sort((a, b) => a.sort - b.sort);
    const owned = await this.payments.ownedOnce(
      account,
      skus.filter((sku) => sku.once).map((sku) => sku.id),
    );
    const method = methodFor(account.platform);
    const promos = await this.promos.active(at);
    const full = (sku: ShopSku) => (method === undefined ? null : priceIn(priceProduct(sku), method));
    // «Лучшая цена», выгода и подбор считаются от того, что игрок заплатит сейчас, — со скидкой.
    const price = (sku: ShopSku) => promoOffer(full(sku), promos.get(sku.id))?.price ?? full(sku);
    const badges = badgesOf(skus, price);
    const value = gemValuePct(skus, price);
    const inventory = await withTimeout(this.items.inventory(account.accountId), DB_TIMEOUT_MS, "магазин");
    const tribute = this.settings.get(SETTINGS.shopTributeUrl);
    return {
      payable: method !== undefined,
      mode: this.payments.mode,
      recommended: recommendedSku(skus, price, { owned, equipped: Object.keys(inventory.equipped).length }),
      tribute: account.platform === "telegram" && tribute !== "" ? tribute : null,
      items: skus.map((sku) => {
        const promo = promos.get(sku.id);
        const offer = promoOffer(full(sku), promo);
        const stars = offer?.price ?? full(sku);
        return {
          sku: sku.id,
          kind: sku.kind,
          contents: contentsOf(sku),
          stars,
          fullStars: offer === null ? null : full(sku),
          promo: offer === null || promo === undefined ? null : promoView(promo, offer.percent),
          chargedStars: stars === null ? null : this.payments.charge(stars).chargedStars,
          once: sku.once,
          owned: owned.has(sku.id),
          badge: badges.get(sku.id) ?? null,
          valuePct: value.get(sku.id) ?? null,
        };
      }),
    };
  }

  async order(account: AccountRef, skuId: string, at = new Date()): Promise<ShopInvoice> {
    const sku = skuById(skuId);
    if (sku === undefined) throw new ShopSkuNotFoundError();
    const method = methodFor(account.platform);
    if (method === undefined) throw new PaymentsUnsupportedError();
    const full = priceIn(priceProduct(sku), method);
    if (full === null) throw new ShopSkuUnavailableError();
    // Счёт — по акции, идущей в момент заказа: оплату площадка спишет по сумме счёта, даже если акция кончится, пока окно открыто.
    const promo = (await this.promos.active(at)).get(sku.id);
    const offer = promoOffer(full, promo);
    const stars = offer?.price ?? full;
    const invoice = await this.payments.shopInvoice(account, { product: "shop_item", sku: sku.id, priceStars: stars, once: sku.once, text: { title: sku.title, description: sku.description } });
    this.log("shop_order", {
      accountId: account.accountId,
      sku: sku.id,
      purchaseId: invoice.purchaseId,
      status: invoice.status,
      stars,
      promoId: offer === null ? null : (promo?.promoId ?? null),
      promoPct: offer?.percent ?? null,
    });
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

function promoView(promo: PromoRow, percent: number): ShopPromoView {
  return { percent, endsAt: promo.endsAt, title: promo.title };
}
