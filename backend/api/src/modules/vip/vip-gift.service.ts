import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "../friends/friends.repository.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { vipGiftInvoiceText } from "../payments/invoice-text.js";
import { methodFor, priceIn } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import { PurchaseRevocation, type Revocation } from "../payments/purchase-revocation.js";
import type { StoredPurchase } from "../payments/purchase-types.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import type { AccountRef } from "../roles/roles.service.js";
import { VIP_GIFT_DAY_LIMIT, cutGiverName, giftNoticeKey, giftOrderRefusal } from "./vip-gift-rules.js";
import { VIP_GIFT_REPOSITORY, type GiftRevocation, type VipGiftRepository } from "./vip-gift.repository.js";
import { VipGiftBlockedError, VipGiftNotFriendError, VipGiftSelfError } from "./vip-errors.js";
import { VIP_GIFT_SKU, vipGiftProduct } from "./vip-plan.js";

/**
 * VIP в подарок другу (docs/35-stage4-plan.md Р155, tasks/T-0249): заказ за звёзды, срок подарка,
 * уведомление получателю и возврат. Оплату ведёт модуль оплаты — счёт, подтверждение, возвраты;
 * здесь решают, кому можно дарить, куда встаёт срок и что делать с ним при возврате.
 *
 * Дарить можно только другу, получатель записывается в заказ на сервере, и подтверждение оплаты
 * берёт его оттуда, а не из клиента. Перестали дружить между оплатой и подтверждением — подарок
 * всё равно выдаётся: оплачено. Покупка — обычная оплата дарящего (docs/37-accounting.md), деньги
 * получатель не платил.
 */

const DB_TIMEOUT_MS = 3_000;

/** Заказы подарка за сутки на дарящего: окно фиксированное, счётчик атомарный (Redis). */
const DAY_LIMIT: RateLimit = { scope: "vip:gift-day", limit: VIP_GIFT_DAY_LIMIT, windowSec: 86_400 };

@Injectable()
export class VipGiftService implements OnModuleInit {
  private readonly logger = new Logger("vip");

  constructor(
    private readonly payments: PaymentsService,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly revocation: PurchaseRevocation,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId" | "byPublicId">,
    @Inject(FRIENDS_REPOSITORY) private readonly friends: Pick<FriendsRepository, "areFriends">,
    private readonly restrictions: AccountRestrictions,
    @Inject(NotificationsService) private readonly notifications: Pick<NotificationsService, "deliver">,
    @Inject(RateLimiter) private readonly limiter: Pick<RateLimiter, "consume">,
    @Inject(VIP_GIFT_REPOSITORY) private readonly repository: VipGiftRepository,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("vip_gift", (purchase) => this.fulfill(purchase));
    this.revocation.register("vip_gift", (purchase, at) => this.revoke(purchase, at));
  }

  /**
   * Счёт на подарок другу по его публичному id. Все проверки — до счёта, и отказ не тратит суточный
   * лимит: тратится он только на заказ, который будет выставлен.
   */
  async order(giver: AccountRef, publicId: string, at = new Date()): Promise<ShopInvoice> {
    // Закрытые покупки (T-0024) отвечают раньше всего остального.
    await this.restrictions.ensure(giver.accountId, "purchases", at);
    const recipient = await withTimeout(this.accounts.byPublicId(publicId), DB_TIMEOUT_MS, "получатель подарка");
    const self = recipient !== null && recipient.accountId === giver.accountId;
    const friends = recipient !== null && !self && (await withTimeout(this.friends.areFriends(giver.accountId, recipient.accountId), DB_TIMEOUT_MS, "дружба"));
    const refusal = giftOrderRefusal({ self, found: recipient !== null, friends, blocked: recipient !== null && recipient.bannedAt !== null });
    if (refusal === "self") throw new VipGiftSelfError();
    if (refusal === "blocked") throw new VipGiftBlockedError();
    if (refusal !== null || recipient === null) throw new VipGiftNotFriendError();

    const method = methodFor(giver.platform);
    const stars = method === undefined ? null : priceIn(vipGiftProduct(), method);
    if (stars === null) throw new PaymentsUnsupportedError();

    if (!(await this.limiter.consume(DAY_LIMIT, giver.accountId))) throw new RateLimitedError("Подарков за сутки больше не оформить — загляни завтра");

    const invoice = await this.payments.shopInvoice(
      giver,
      { product: "vip_gift", sku: VIP_GIFT_SKU.sku, priceStars: stars, once: false, text: vipGiftInvoiceText(VIP_GIFT_SKU.title, recipient.displayName, VIP_GIFT_SKU.days) },
      at.getTime(),
    );
    // Получатель записывается раньше, чем клиент получит ссылку на оплату: сбой записи — отказ без ссылки.
    await withTimeout(this.repository.recordOrder({ purchaseId: invoice.purchaseId, recipientAccountId: recipient.accountId, at }), DB_TIMEOUT_MS, "заказ подарка");
    this.log("vip_gift_order", { accountId: giver.accountId, recipientAccountId: recipient.accountId, purchaseId: invoice.purchaseId, status: invoice.status });
    return invoice;
  }

  /**
   * Выдача оплаченного подарка: срок получателю и уведомление. Повтор той же покупки срок не меняет,
   * а уведомление пишет заново с тем же ключом — так сбой ленты после записи срока чинится повтором
   * задания и второй строки не заводит. Получателя берёт из заказа на сервере.
   */
  async fulfill(purchase: StoredPurchase, at = new Date()): Promise<void> {
    if (purchase.paidAt === null) throw new Error(`покупка ${purchase.purchaseId} не оплачена — подарок не выдаётся`);
    const recipientAccountId = await withTimeout(this.repository.recipientOf(purchase.purchaseId), DB_TIMEOUT_MS, "получатель подарка");
    if (recipientAccountId === null) throw new Error(`у покупки ${purchase.purchaseId} нет заказа — получатель подарка неизвестен`);

    const issued = await withTimeout(
      this.repository.issue({ purchaseId: purchase.purchaseId, giverAccountId: purchase.accountId, recipientAccountId, days: VIP_GIFT_SKU.days, at }),
      DB_TIMEOUT_MS,
      "срок подарка",
    );
    if (issued.created) {
      this.log("vip_gift_issued", {
        accountId: purchase.accountId,
        recipientAccountId,
        purchaseId: purchase.purchaseId,
        startsAt: issued.startsAt.toISOString(),
        endsAt: issued.endsAt.toISOString(),
        revoked: issued.revokedAt !== null,
      });
    }
    // Возвращённый до выдачи подарок получателю не показывается: срока у него нет.
    if (issued.revokedAt !== null) return;

    const giver = await withTimeout(this.accounts.byId(purchase.accountId), DB_TIMEOUT_MS, "дарящий");
    await this.notifications.deliver({
      accountId: recipientAccountId,
      kind: "vip_gift",
      payload: { fromName: cutGiverName(giver?.displayName ?? ""), days: VIP_GIFT_SKU.days },
      dedupeKey: giftNoticeKey(purchase.purchaseId),
      at,
    });
  }

  /**
   * Возврат звёзд за подарок (`PurchaseRevocation`): срок отзывается ровно в момент возврата. Не начался —
   * пропадает целиком, идёт — обрывается сейчас, кончился — забирать нечего. Следующие подарки того же
   * получателя не сдвигаются; получателю уведомление не шлётся. Повтор срок и время отзыва не меняет.
   */
  async revoke(purchase: StoredPurchase, at: Date): Promise<Revocation> {
    const result = await withTimeout(this.repository.revoke(purchase.purchaseId, at), DB_TIMEOUT_MS, "возврат подарка");
    if (result.kind === "none") return { lines: ["VIP в подарок: срока нет — если выдача ещё впереди, она увидит возврат сама"] };
    this.log("vip_gift_revoked", {
      accountId: purchase.accountId,
      recipientAccountId: result.recipientAccountId,
      purchaseId: purchase.purchaseId,
      repeat: result.kind === "repeat",
      revokedAt: result.revokedAt.toISOString(),
    });
    return { lines: [revocationLine(result)] };
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "vip", event, ...fields }));
  }
}

function revocationLine(result: Exclude<GiftRevocation, { kind: "none" }>): string {
  if (result.kind === "repeat") return `VIP в подарок: срок уже отозван ${utcMinute(result.revokedAt)}`;
  if (result.revokedAt.getTime() <= result.startsAt.getTime()) return "VIP в подарок: срок не начался и убран целиком";
  if (result.revokedAt.getTime() >= result.endsAt.getTime()) return "VIP в подарок: срок уже кончился, забирать нечего";
  return `VIP в подарок: срок оборван ${utcMinute(result.revokedAt)}, было до ${utcMinute(result.endsAt)}`;
}

/** ГГГГ-ММ-ДД ЧЧ:ММ по UTC: сервер и логи в UTC, команда сверяет по ним. */
function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
