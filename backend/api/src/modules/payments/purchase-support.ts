import { Inject, Injectable, Logger } from "@nestjs/common";
import { ForbiddenError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { FulfillFailedError, PurchaseActionUnavailableError, PurchaseNotFoundError, PurchaseUndeliverableError } from "./payments-errors.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentsQueue } from "./payments-queue.js";
import { PurchaseFulfillment, UndeliverableError } from "./purchase-fulfillment.js";
import type { PurchaseAction, StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Поддержка покупок (docs/35-stage4-plan.md, WP10, tasks/T-0037): вернуть
 * звёзды за оплаченную покупку и повторить выдачу той, что не дошла. Право —
 * `payments.support` (владелец и админ), каждое действие — с причиной, в
 * журнале действий и сообщением в поток «Покупки».
 *
 * Что открыто по покупке, решает сервер (`actionsFor`), и перед действием он
 * проверяет всё ещё раз: кнопка в панели могла устареть. Себе нельзя — как с
 * кошельком; исключение — вход разработчика, чтобы проверить на себе.
 *
 * **Возврат** только заказывается: заказ пишется в базу, а звёзды возвращает
 * задание очереди, и уже после этого оно забирает остаток покупки
 * (`payment-refunds.ts`). **Выдача** идёт сразу, в запросе: поддержка должна
 * видеть, прошла ли она. Дважды она не выдаст — у выдачи магазина ключ в
 * журнале кошелька, у VIP — период по покупке.
 */

const FULFILL_TIMEOUT_MS = 10_000;

const REFUND_ALREADY_ORDERED = "Возврат уже заказан — звёзды в пути";

export interface SupportResult {
  purchase: StoredPurchase;
  actions: PurchaseAction[];
}

@Injectable()
export class PurchaseSupport {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly refunds: PaymentRefunds,
    private readonly queue: PaymentsQueue,
    private readonly hooks: PaymentsHooks,
  ) {}

  /** Что открыто по покупке сейчас. Право вызывающий проверяет сам. Сначала то, что не стоит денег. */
  actionsFor(purchase: StoredPurchase): PurchaseAction[] {
    const actions: PurchaseAction[] = [];
    if (this.canFulfill(purchase)) actions.push("fulfill");
    if (canRefund(purchase)) actions.push("refund");
    return actions;
  }

  async refund(actor: AccountRef, accountId: string, purchaseId: string, note: string, now = new Date()): Promise<SupportResult> {
    const purchase = await this.load(actor, accountId, purchaseId, "refund");
    const orders = await this.refunds.manual(purchaseId, now.getTime());
    // Пусто — звёзды успели вернуть; не наша причина — успел встать другой возврат, и первая причина остаётся.
    // И в том и в другом случае нашего заказа нет: ни аудита, ни сообщения команде.
    if (orders[0]?.reason !== "manual") throw new PurchaseActionUnavailableError(REFUND_ALREADY_ORDERED);
    // Сбой постановки не страшен: заказ уже в базе, и очередь поднимет его при перезапуске.
    await this.queue.dispatchRefunds(Promise.resolve(orders));
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "payments.refund",
      target: accountId,
      before: { purchaseId, fulfilledAt: purchase.fulfilledAt },
      after: { purchaseId, reason: "manual", chargedStars: purchase.chargedStars, note },
    });
    const updated = await this.reload(purchaseId);
    await this.hooks.emitSupport({ kind: "refund", purchase: updated, actorName: await this.nameOf(actor), note, at: now });
    this.log("log", "purchase_refund_ordered", { purchaseId, accountId, actorAccountId: actor.accountId, chargedStars: purchase.chargedStars });
    return { purchase: updated, actions: this.actionsFor(updated) };
  }

  async fulfill(actor: AccountRef, accountId: string, purchaseId: string, note: string, now = new Date()): Promise<SupportResult> {
    const purchase = await this.load(actor, accountId, purchaseId, "fulfill");
    await this.deliver(purchase);
    await this.purchases.markFulfilled(purchaseId, now);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "payments.fulfill",
      target: accountId,
      before: { purchaseId },
      after: { purchaseId, note },
    });
    const updated = await this.reload(purchaseId);
    await this.hooks.emitSupport({ kind: "fulfill", purchase: updated, actorName: await this.nameOf(actor), note, at: now });
    this.log("log", "purchase_fulfilled_manually", { purchaseId, accountId, actorAccountId: actor.accountId, chargedStars: purchase.chargedStars });
    return { purchase: updated, actions: this.actionsFor(updated) };
  }

  /**
   * Общее начало обоих действий: право, покупка именно этого игрока, не своя и действие всё ещё открыто.
   * Чужая покупка и несуществующая отвечают одинаково, чтобы по ответу нельзя было перебирать идентификаторы.
   */
  private async load(actor: AccountRef, accountId: string, purchaseId: string, kind: PurchaseAction): Promise<StoredPurchase> {
    await this.roles.require(actor, "payments.support");
    const purchase = await this.purchases.byId(purchaseId);
    if (purchase === null || purchase.accountId !== accountId) throw new PurchaseNotFoundError();
    if (actor.accountId === purchase.accountId && !this.config.auth.devLogin) {
      throw new ForbiddenError(kind === "refund" ? "Возвращать звёзды за свою покупку нельзя" : "Выдавать свою покупку нельзя");
    }
    if (!this.actionsFor(purchase).includes(kind)) throw new PurchaseActionUnavailableError(this.unavailableReason(purchase, kind));
    return purchase;
  }

  /** Первая подходящая причина, почему действия нет — для человека в панели. */
  private unavailableReason(purchase: StoredPurchase, kind: PurchaseAction): string {
    if (purchase.paidAt === null) return "Покупка не оплачена";
    if (purchase.refundedAt !== null) return "Звёзды за покупку уже возвращены";
    if (purchase.refundRequestedAt !== null) return REFUND_ALREADY_ORDERED;
    if (kind === "refund") return "У оплаты нет номера площадки — вернуть её отсюда нельзя";
    if (purchase.fulfilledAt !== null) return "Покупка уже выдана";
    return "У этого товара нет выдачи: второй шанс засчитывается в забеге";
  }

  private canFulfill(purchase: StoredPurchase): boolean {
    return (
      purchase.paidAt !== null &&
      purchase.fulfilledAt === null &&
      purchase.refundRequestedAt === null &&
      purchase.refundedAt === null &&
      this.fulfillment.products().includes(purchase.product)
    );
  }

  /**
   * Выдать хозяином товара. Товара нет в каталоге — отказ по сути, остаётся вернуть звёзды; любая другая ошибка
   * (база, кошелёк, код) в лог сервера, а поддержке — «попробуйте позже»: подробности ей ни к чему.
   */
  private async deliver(purchase: StoredPurchase): Promise<void> {
    try {
      const delivered = await withTimeout(this.fulfillment.fulfill(purchase), FULFILL_TIMEOUT_MS, "выдача покупки");
      // Выдавать нечего: хозяина товара больше нет. Отмечать такую покупку выданной нельзя — это ложь в учёте.
      if (!delivered) throw new PurchaseActionUnavailableError(this.unavailableReason(purchase, "fulfill"));
    } catch (error: unknown) {
      if (error instanceof PurchaseActionUnavailableError) throw error;
      if (error instanceof UndeliverableError) throw new PurchaseUndeliverableError();
      this.log("error", "purchase_support_fulfill_failed", { purchaseId: purchase.purchaseId, reason: error instanceof Error ? error.message : "unknown" });
      throw new FulfillFailedError();
    }
  }

  private async reload(purchaseId: string): Promise<StoredPurchase> {
    const purchase = await this.purchases.byId(purchaseId);
    if (purchase === null) throw new PurchaseNotFoundError();
    return purchase;
  }

  /**
   * Имя — как в аккаунте; нет аккаунта или он не прочитался — его id: действие уже выполнено, и сообщение
   * команде не должно из-за имени превратиться в ошибку запроса.
   */
  private async nameOf(actor: AccountRef): Promise<string> {
    try {
      return (await this.accounts.byId(actor.accountId))?.displayName ?? actor.accountId;
    } catch (error: unknown) {
      this.log("warn", "purchase_support_name_unread", { actorAccountId: actor.accountId, reason: error instanceof Error ? error.message : "unknown" });
      return actor.accountId;
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

/** Звёзды можно вернуть, если оплата есть, у неё есть номер площадки и возврат ещё не заказан. */
function canRefund(purchase: StoredPurchase): boolean {
  return purchase.paidAt !== null && purchase.telegramChargeId !== null && purchase.refundRequestedAt === null && purchase.refundedAt === null;
}
