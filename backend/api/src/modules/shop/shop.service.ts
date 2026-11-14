import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { appearanceById } from "../appearance/appearance-catalog.js";
import { APPEARANCE_GRANTS_REPOSITORY, NO_APPEARANCE_GRANTS, type AppearanceGrantsRepository } from "../appearance/appearance-grants.repository.js";
import { ItemsService } from "../items/items.service.js";
import { methodFor, priceIn } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment, UndeliverableError } from "../payments/purchase-fulfillment.js";
import { PurchaseRevocation, type Revocation } from "../payments/purchase-revocation.js";
import type { PaymentMode, StoredPurchase } from "../payments/purchase-types.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { WALLET_RESOURCES } from "../wallet/wallet-types.js";
import type { RevokeOutcome } from "../wallet/wallet.repository.js";
import { WalletService } from "../wallet/wallet.service.js";
import { badgesOf, gemValuePct, recommendedSku, type ShopBadge } from "./shop-marketing.js";
import { ShopChoice, choiceOf } from "./shop-choice.js";
import { ShopSkuNotFoundError, ShopSkuUnavailableError } from "./shop-errors.js";
import { promoOffer, type PromoRow } from "./shop-promo-rules.js";
import { ShopPromoService } from "./shop-promo.service.js";
import { KeeperSet, NO_FIRST_WIN, isKeeperSet, type KeeperSetWindow } from "./keeper-set.js";
import { appearanceOf, contentsOf, priceProduct, type ShopKind, type ShopResource, type ShopSku } from "./shop-catalog.js";
import { NO_SHOP_OVERRIDES, ShopOverrides } from "./shop-overrides.js";

/**
 * Магазин (docs/35-stage4-plan.md §3.6, WP10): витрина с ценой способа оплаты
 * площадки игрока, счёт на товар и выдача после подтверждения оплаты.
 *
 * Оплату ведёт модуль оплаты — цепочка второго шанса, обобщённая на товары;
 * магазин решает, что продаётся и почём, и кладёт оплаченное на счёт игрока
 * журналом кошелька с ключом покупки. Выдачу зовёт задание подтверждения
 * оплаты, и повтор ничего не удваивает.
 *
 * «Набор хранителя» (`keeper-set.ts`, T-0245) — позиция с окном: виден и заказывается только
 * 48 часов после первой победы над Рубежом, а окрас из состава выдаётся строкой
 * `appearance_grant` рядом с самоцветами. Акции на него не действуют, а подбор «Рекомендуем»
 * его не берёт: у набора своя карточка и свой срок.
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
  /** «Хит» — от команды, «Выбор игроков» — у набора с наибольшим числом покупателей за 30 дней, «Лучшая цена» — у самого выгодного набора самоцветов */
  badge: ShopBadge | null;
  /** на сколько процентов самоцвет здесь дешевле, чем в самом дорогом наборе; `null` — не набор самоцветов или это он и есть */
  valuePct: number | null;
  /** окрас героя в составе — id облика (T-0245); `null` — окраса нет */
  appearance: string | null;
  /** до какого момента товар продаётся (набор хранителя); `null` — без срока */
  until: Date | null;
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

const CLOSED_WINDOW: KeeperSetWindow = { open: false, until: null };

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
    // Реестр нужен модулю, а не каждому тесту магазина: без него отзыв регистрируется в своём, пустом.
    private readonly revocation: PurchaseRevocation = new PurchaseRevocation(),
    private readonly restrictions: AccountRestrictions,
    private readonly choice: ShopChoice,
    // Правки команды поверх каталога (T-0309); без них — каталог в коде, как у тестов без базы.
    private readonly overrides: ShopOverrides = new ShopOverrides(NO_SHOP_OVERRIDES),
    // Окно набора хранителя и выдачи обликов (T-0245); без них — набор никому не открыт, выдавать некому.
    private readonly keeper: KeeperSet = new KeeperSet(NO_FIRST_WIN),
    @Inject(APPEARANCE_GRANTS_REPOSITORY) private readonly grants: AppearanceGrantsRepository = NO_APPEARANCE_GRANTS,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("shop_item", (purchase) => this.fulfill(purchase));
    this.revocation.register("shop_item", (purchase, at) => this.revoke(purchase, at));
  }

  async view(account: AccountRef, at = new Date()): Promise<ShopView> {
    const all = [...(await this.overrides.skus())].sort((a, b) => a.sort - b.sort);
    const owned = await this.payments.ownedOnce(
      account,
      all.filter((sku) => sku.once).map((sku) => sku.id),
    );
    // Набор хранителя — в витрине, пока открыто его окно и он не куплен: купленный разовый набор с
    // «Куплено» на всю витрину не нужен, а после окна его и вовсе нет.
    const keeper = all.some((sku) => isKeeperSet(sku) && !owned.has(sku.id)) ? await this.keeperWindowOrClosed(account, at) : CLOSED_WINDOW;
    const skus = all.filter((sku) => !isKeeperSet(sku) || (keeper.open && !owned.has(sku.id)));
    // Подбор, «Лучшая цена» и выбор игроков — по постоянным товарам: набор живёт своей карточкой.
    const evergreen = skus.filter((sku) => !isKeeperSet(sku));
    const method = methodFor(account.platform);
    const promos = await this.promos.active(at);
    const promoOf = (sku: ShopSku) => (isKeeperSet(sku) ? undefined : promos.get(sku.id));
    const full = (sku: ShopSku) => (method === undefined ? null : priceIn(priceProduct(sku), method));
    // «Лучшая цена», выгода и подбор считаются от того, что игрок заплатит сейчас, — со скидкой.
    const price = (sku: ShopSku) => promoOffer(full(sku), promoOf(sku))?.price ?? full(sku);
    const sellable = evergreen.filter((sku) => price(sku) !== null);
    const choiceId = choiceOf(await this.choice.counts(at), sellable, this.settings.get(SETTINGS.shopChoiceMinBuyers));
    const badges = badgesOf(skus, price, choiceId);
    const value = gemValuePct(skus, price);
    const inventory = await withTimeout(this.items.inventory(account.accountId), DB_TIMEOUT_MS, "магазин");
    const tribute = this.settings.get(SETTINGS.shopTributeUrl);
    return {
      payable: method !== undefined,
      mode: this.payments.mode,
      recommended: recommendedSku(evergreen, price, { owned, equipped: Object.keys(inventory.equipped).length }),
      tribute: account.platform === "telegram" && tribute !== "" ? tribute : null,
      items: skus.map((sku) => {
        const promo = promoOf(sku);
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
          appearance: appearanceOf(sku),
          until: isKeeperSet(sku) ? keeper.until : null,
        };
      }),
    };
  }

  async order(account: AccountRef, skuId: string, at = new Date()): Promise<ShopInvoice> {
    // Закрытые покупки (T-0024) отвечают раньше всего остального: аккаунту незачем знать, что с товаром.
    await this.restrictions.ensure(account.accountId, "purchases", at);
    const sku = await this.overrides.sku(skuId);
    if (sku === undefined) throw new ShopSkuNotFoundError();
    // Вне окна набора нет ни в витрине, ни в заказе: ответ тот же, что у несуществующего товара. Окно не
    // прочиталось — заказ не выставляется, продавать то, что не удалось проверить, нельзя.
    if (isKeeperSet(sku) && !(await this.keeper.window(account.accountId, at)).open) throw new ShopSkuNotFoundError();
    const method = methodFor(account.platform);
    if (method === undefined) throw new PaymentsUnsupportedError();
    const full = priceIn(priceProduct(sku), method);
    if (full === null) throw new ShopSkuUnavailableError();
    // Счёт — по акции, идущей в момент заказа: оплату площадка спишет по сумме счёта, даже если акция кончится, пока окно открыто.
    // На набор хранителя акции не действуют: зачёркнутой цены у него нет.
    const promo = isKeeperSet(sku) ? undefined : (await this.promos.active(at)).get(sku.id);
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
   * а после него проход довыдачи вернёт звёзды (`payments/fulfillment-sweeper.ts`).
   * Поэтому товар с витрины не удаляют, пока по нему могут прийти оплаты
   * открытых счетов (`INVOICE_TTL_SEC`).
   */
  async fulfill(purchase: StoredPurchase): Promise<void> {
    const sku = purchase.sku === null ? undefined : await this.overrides.sku(purchase.sku);
    if (sku === undefined) throw new UndeliverableError(`товара ${purchase.sku ?? "—"} нет в каталоге — выдавать нечего`);
    // Окрас, которого нет в каталоге обликов, не выдать: отказ раньше любых начислений, чтобы не оставить набор половиной.
    const appearance = appearanceOf(sku);
    if (appearance !== null && appearanceById(appearance) === undefined) throw new UndeliverableError(`облика ${appearance} из товара ${sku.id} нет в каталоге — выдавать нечего`);
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
    // Покупка помечается выданной только после обоих шагов: упала выдача окраса — задание повторится, а самоцветы
    // второй раз не лягут (ключ покупки), строка окраса — `ON CONFLICT DO NOTHING`.
    if (appearance !== null) {
      await this.grants.grant({ accountId: purchase.accountId, appearanceId: appearance, source: "purchase", purchaseId: purchase.purchaseId, grantedAt: new Date() });
    }
    this.log("shop_fulfilled", { accountId: purchase.accountId, sku: sku.id, purchaseId: purchase.purchaseId, mode: purchase.mode, appearance });
  }

  /**
   * Отзыв остатка набора при внешнем возврате звёзд (tasks/T-0023): каждый
   * ресурс — до того, что осталось от начисления этой покупки, не больше и
   * не больше баланса. Потраченное не возвращается. Идемпотентно ключом
   * отзыва: обработка возврата повторяется, пока не пройдёт целиком, и
   * ресурсы, забранные в прошлую попытку, второй раз не списываются.
   *
   * Ресурсы берутся все, а не из каталога: товар мог уйти из каталога после
   * покупки, а ключи начисления остались. Окрас набора (T-0245) снимается строкой
   * выдачи по покупке; повтор обработки возврата второй раз ничего не снимает.
   */
  async revoke(purchase: StoredPurchase, at: Date): Promise<Revocation> {
    const lines: string[] = [];
    for (const resource of WALLET_RESOURCES) {
      const outcome = await this.wallet.revokeUpTo({
        accountId: purchase.accountId,
        resource,
        grantKey: `purchase:${purchase.purchaseId}:${resource}`,
        idempotencyKey: `refund:${purchase.purchaseId}:${resource}`,
        source: purchase.sku === null ? "shop" : `shop:${purchase.sku}`,
        at,
      });
      if (outcome.granted > 0) lines.push(`${resource}: ${revokedOf(outcome)} из ${outcome.granted}`);
    }
    // Окрас снимается по покупке, а не по каталогу: товар мог уйти из каталога, а строка выдачи осталась.
    // Выбранный облик у игрока не стирается — действующим станет Хранитель, пока владение не вернётся.
    for (const appearance of await this.grants.revokeByPurchase(purchase.purchaseId)) lines.push(`облик ${appearance}: снят`);
    return { lines: lines.length > 0 ? lines : ["ничего — начислений покупки нет"] };
  }

  /**
   * Окно набора для витрины. Сбой чтения витрину не ломает: набора на ней просто нет, остальные
   * товары продаются, а причина остаётся в журнале.
   */
  private async keeperWindowOrClosed(account: AccountRef, at: Date): Promise<KeeperSetWindow> {
    try {
      return await this.keeper.window(account.accountId, at);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "shop", event: "keeper_window_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return CLOSED_WINDOW;
    }
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "shop", event, ...fields }));
  }
}

/** Сколько забрали: при `nothing` — ничего (баланс уже пуст), при повторе — то, что забрали в первый раз. */
function revokedOf(outcome: RevokeOutcome): number {
  return outcome.status === "nothing" ? 0 : outcome.revoked;
}

function promoView(promo: PromoRow, percent: number): ShopPromoView {
  return { percent, endsAt: promo.endsAt, title: promo.title };
}
