import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { methodFor } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import { PurchaseRevocation, type Revocation } from "../payments/purchase-revocation.js";
import type { PaymentMode, StoredPurchase } from "../payments/purchase-types.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { presetsFor } from "./donation-amounts.js";
import { DONATIONS_REPOSITORY, type DonationsRepository } from "./donations.repository.js";

/**
 * Донаты проекту (docs/35-stage4-plan.md, Р109): игрок поддерживает проект
 * деньгами без покупки товара и получает знак «Поддержал проект».
 *
 * Донат звёздами идёт той же цепочкой, что магазин (`PaymentsService.shopInvoice`):
 * предварительная проверка, подтверждение очередью, возвраты и довыдача —
 * прежние. Игровых ценностей он не даёт: выдача — один знак на аккаунте
 * (`account.supporter_at`), а в покупках донат лежит отдельным видом, чтобы
 * бухгалтерия вела по нему свою статью, а воронка не считала его покупкой.
 *
 * Донат по ссылке Tribute с аккаунтом не связан и знака не даёт: оплата идёт
 * вне игры, сервер лишь отдаёт ссылку площадки игрока.
 */

/** Чья это ссылка Tribute: Telegram или веба — клиент берёт разрез из ответа, а не угадывает по площадке. */
export type TributeWay = "tribute_telegram" | "tribute_web";

export interface DonationView {
  /** звёздная часть; `null` — оплата выключена, площадка без способа, платить нечем или покупки закрыты */
  stars: { min: number; max: number; presets: number[]; mode: PaymentMode } | null;
  /** ссылка Tribute для площадки игрока и её разрез в аналитике; `null` — кнопки нет */
  tribute: { url: string; way: TributeWay } | null;
  /** аккаунт уже поддержал проект */
  supporter: boolean;
}

/** Название счёта — до 32 знаков, предел Telegram; игровых наград у доната нет, и текст говорит об этом прямо. */
const INVOICE_TEXT = {
  title: "Поддержка проекта",
  description: "Добровольный взнос на развитие «Рубежа». Игровых наград за него нет — только благодарность и знак «Поддержал проект».",
} as const;

@Injectable()
export class DonationsService implements OnModuleInit {
  private readonly logger = new Logger("donations");

  constructor(
    private readonly payments: PaymentsService,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly revocation: PurchaseRevocation,
    @Inject(DONATIONS_REPOSITORY) private readonly repository: DonationsRepository,
    private readonly restrictions: AccountRestrictions,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("donation", (purchase) => this.fulfill(purchase));
    this.revocation.register("donation", (purchase, at) => this.revoke(purchase, at));
  }

  async view(account: AccountRef, at = new Date()): Promise<DonationView> {
    const [stars, supporter] = await Promise.all([this.starsPart(account, at), this.repository.isSupporter(account.accountId)]);
    return { stars, tribute: this.tributeFor(account.platform), supporter };
  }

  /**
   * Счёт на сумму. Закрытые покупки (T-0024) отвечают раньше всего остального:
   * аккаунту незачем знать, что не так с заказом. Сумму решает игрок, но в
   * пределах способа оплаты площадки — выше или ниже счёт не выставляется.
   */
  async order(account: AccountRef, amount: number, at = new Date()): Promise<ShopInvoice> {
    await this.restrictions.ensure(account.accountId, "purchases", at);
    const method = methodFor(account.platform);
    if (method === undefined) throw new PaymentsUnsupportedError();
    if (!Number.isInteger(amount) || amount < Number(method.minAmount) || amount > Number(method.maxAmount)) throw new ValidationError("Некорректная сумма");
    const invoice = await this.payments.shopInvoice(account, { product: "donation", sku: "donation", priceStars: amount, once: false, text: INVOICE_TEXT }, at.getTime());
    this.log("donation_order", { accountId: account.accountId, purchaseId: invoice.purchaseId, stars: amount, status: invoice.status });
    return invoice;
  }

  /**
   * Выдача оплаченного доната — знак на аккаунте. Идемпотентна: дата первого
   * доната не перезаписывается, и повтор задания подтверждения ничего не меняет.
   */
  async fulfill(purchase: StoredPurchase): Promise<void> {
    await this.repository.markSupporter(purchase.accountId, purchase.paidAt ?? new Date());
    this.log("donation_fulfilled", { accountId: purchase.accountId, purchaseId: purchase.purchaseId, mode: purchase.mode });
  }

  /**
   * Отзыв при возврате звёзд: знак снимается, если других оплаченных и не
   * возвращённых донатов у аккаунта нет. Обработка возврата повторяется, пока не
   * пройдёт целиком, поэтому отзыв идемпотентен и отвечает одинаково.
   */
  async revoke(purchase: StoredPurchase, at: Date): Promise<Revocation> {
    const cleared = await this.repository.clearSupporterUnlessOther(purchase.accountId, purchase.purchaseId);
    if (!cleared) return { lines: ["знак остаётся: есть другой донат"] };
    this.log("supporter_revoked", { accountId: purchase.accountId, purchaseId: purchase.purchaseId, at: at.toISOString() });
    return { lines: ["знак «Поддержал проект» снят"] };
  }

  private async starsPart(account: AccountRef, at: Date): Promise<DonationView["stars"]> {
    if (!this.payments.canPay(account)) return null;
    const method = methodFor(account.platform);
    if (method === undefined) return null;
    if ((await this.restrictions.status(account.accountId, "purchases", at)) !== null) return null;
    const min = Number(method.minAmount);
    const max = Number(method.maxAmount);
    return { min, max, presets: presetsFor(this.settings.get(SETTINGS.donateAmounts), min, max), mode: this.payments.mode };
  }

  /** Ссылка площадки игрока; у MAX и VK Tribute нет совсем, пустая ссылка — кнопки нет. */
  private tributeFor(platform: PlatformId): DonationView["tribute"] {
    if (platform === "telegram") return tribute(this.settings.get(SETTINGS.donateTributeUrlTelegram), "tribute_telegram");
    if (platform === "web") return tribute(this.settings.get(SETTINGS.donateTributeUrlWeb), "tribute_web");
    return null;
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "donations", event, ...fields }));
  }
}

function tribute(url: string, way: TributeWay): DonationView["tribute"] {
  return url === "" ? null : { url, way };
}
