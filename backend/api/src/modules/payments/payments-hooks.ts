import { Injectable, Logger } from "@nestjs/common";
import type { PlatformId } from "../../platforms/ports/platform.js";
import type { DiscrepancyKind } from "./payment-reconcile.js";
import type { PaymentMode, PurchaseAction, PurchaseProduct, StoredPurchase } from "./purchase-types.js";

/**
 * Что случилось с оплатой — кому это интересно: воронке (первая покупка),
 * хозяину подписки (продление отменено), потом заданиям и бухгалтерии.
 * Модуль оплаты о них не знает: слушатели подписываются сами — тот же приём,
 * что `RunsHooks`.
 *
 * Событие оплаты — только о **первом** подтверждении: повтор обновления от
 * площадки слушателей не зовёт.
 */
export interface PaidPurchase {
  purchaseId: string;
  accountId: string;
  /** что оплачено: донат (Р109) — поддержка, а не покупка, и слушатели денег-за-товар его пропускают */
  product: PurchaseProduct;
  /** тестовая оплата — не выручка: слушатели, которым нужны деньги, её пропускают */
  mode: PaymentMode;
  at: Date;
}

/** Продление подписки: `cancelled` — отменено на площадке, `active` — возвращено, `failed` — площадка не смогла списать. */
export type SubscriptionState = "active" | "cancelled" | "failed";

/** Площадка сообщила о продлении подписки: что с ним и какая это подписка. */
export interface SubscriptionChange {
  /** первая покупка подписки — по её счёту площадка и списывает периоды */
  subscription: StoredPurchase;
  state: SubscriptionState;
  at: Date;
}

/**
 * Оплаченная покупка, которую проход довыдачи не смог закрыть выдачей: товара
 * нет в каталоге (`reason: "undeliverable"`, звёзды возвращаются сами) или
 * выдача падает по другой причине (`reason` — её текст, нужен человек).
 */
export interface StuckPurchase {
  purchaseId: string;
  accountId: string;
  product: PurchaseProduct;
  sku: string | null;
  chargedStars: number;
  paidAt: Date;
  reason: string;
}

/**
 * Задание очереди оплаты, которое не прошло ни с одной из попыток: запись
 * оплаты или возврата не легла в базу, пока та лежала, или Telegram не принял
 * возврат. Очередь больше не повторит его — покупку сверяет человек.
 */
export interface AbandonedJob {
  /** идентификатор задания в очереди: по нему сообщение команде не повторяется */
  jobId: string;
  /** подтверждение оплаты, заказанный нами возврат или возврат, пришедший от площадки */
  kind: "confirm" | "refund" | "refunded";
  chargeId: string;
  /** внешний возврат приходит с одним идентификатором оплаты, без покупки */
  purchaseId: string | null;
  reason: string;
}

/**
 * Деньги вернулись игроку не по нашей воле (спор, поддержка Telegram) и остаток покупки
 * уже забран (tasks/T-0023): команде — карточка, аккаунту покупки уже закрыты (T-0024).
 */
export interface ExternalRefund {
  purchase: StoredPurchase;
  /** что забрал отзыв остатка — строками, как в логе */
  revoked: string[];
  /** настоящие оплаты аккаунта и возвраты по ним не по нашей воле — доля возвратов (О4) */
  stats: { paid: number; refunded: number };
  at: Date;
}

/** Действие поддержки с покупкой — для сообщения команде. */
export interface SupportAction {
  kind: PurchaseAction;
  purchase: StoredPurchase;
  /** имя того, кто сделал, — как в аккаунте; нет аккаунта — его id */
  actorName: string;
  note: string;
  at: Date;
  /** самоцветы компенсации (Р209) — только у `compensate` */
  gems?: number;
  /** что именно сделано — строкой для сообщения команде, например «повторено заданий: 2» (Р209) */
  detail?: string;
}

/**
 * Звёзды вернулись по нашему заказу (Р209): покупка уже отмечена возвращённой, остаток —
 * забран, если был. Приходит один раз на покупку, при первой отметке возврата.
 */
export interface RefundDone {
  purchase: StoredPurchase;
  /** отзыв остатка покупки что-то вернул в счёт — только у возврата поддержкой */
  revoked: boolean;
  at: Date;
}

/**
 * Сверка с выпиской площадки нашла новые расхождения (Р209, tasks/T-0433): одно
 * событие на сверку площадки. `found` — сколько новых, `kinds` — их по видам (только
 * ненулевые), `open` — сколько открытых расхождений площадки после сверки.
 */
export interface ReconcileFound {
  platform: PlatformId;
  found: number;
  open: number;
  kinds: Partial<Record<DiscrepancyKind, number>>;
  at: Date;
}

export type StuckListener = (purchase: StuckPurchase) => Promise<void>;
export type AbandonedListener = (job: AbandonedJob) => Promise<void>;

export type ExternalRefundListener = (refund: ExternalRefund) => Promise<void>;
export type PaidListener = (purchase: PaidPurchase) => Promise<void>;
export type SubscriptionListener = (change: SubscriptionChange) => Promise<void>;
export type SupportListener = (action: SupportAction) => Promise<void>;
export type RefundDoneListener = (event: RefundDone) => Promise<void>;
export type ReconcileFoundListener = (event: ReconcileFound) => Promise<void>;

@Injectable()
export class PaymentsHooks {
  private readonly logger = new Logger("payments");
  private readonly paid: { name: string; listener: PaidListener }[] = [];
  private readonly subscriptions: { name: string; listener: SubscriptionListener }[] = [];
  private readonly stuck: { name: string; listener: StuckListener }[] = [];
  private readonly abandoned: { name: string; listener: AbandonedListener }[] = [];
  private readonly externalRefunds: { name: string; listener: ExternalRefundListener }[] = [];
  private readonly support: { name: string; listener: SupportListener }[] = [];
  private readonly refundDone: { name: string; listener: RefundDoneListener }[] = [];
  private readonly reconcileFound: { name: string; listener: ReconcileFoundListener }[] = [];

  onPaid(name: string, listener: PaidListener): void {
    this.paid.push({ name, listener });
  }

  onSubscriptionChanged(name: string, listener: SubscriptionListener): void {
    this.subscriptions.push({ name, listener });
  }

  onStuck(name: string, listener: StuckListener): void {
    this.stuck.push({ name, listener });
  }

  onAbandoned(name: string, listener: AbandonedListener): void {
    this.abandoned.push({ name, listener });
  }

  onExternalRefund(name: string, listener: ExternalRefundListener): void {
    this.externalRefunds.push({ name, listener });
  }

  onSupport(name: string, listener: SupportListener): void {
    this.support.push({ name, listener });
  }

  onRefundDone(name: string, listener: RefundDoneListener): void {
    this.refundDone.push({ name, listener });
  }

  onReconcileFound(name: string, listener: ReconcileFoundListener): void {
    this.reconcileFound.push({ name, listener });
  }

  /** После записи оплаты; упавший слушатель не отменяет ни её, ни остальных. */
  emitPaid(purchase: PaidPurchase): Promise<void> {
    return this.emit(this.paid, purchase, { purchaseId: purchase.purchaseId });
  }

  /** Покупка зависла: проход довыдачи не смог её закрыть. Упавший слушатель не мешает остальным. */
  emitStuck(purchase: StuckPurchase): Promise<void> {
    return this.emit(this.stuck, purchase, { purchaseId: purchase.purchaseId });
  }

  /** Задание оплаты брошено после всех попыток. Упавший слушатель не мешает остальным. */
  emitAbandoned(job: AbandonedJob): Promise<void> {
    return this.emit(this.abandoned, job, { jobId: job.jobId });
  }

  /** Внешний возврат обработан: остаток забран, покупки закрыты. Упавший слушатель не мешает остальным. */
  emitExternalRefund(refund: ExternalRefund): Promise<void> {
    return this.emit(this.externalRefunds, refund, { purchaseId: refund.purchase.purchaseId });
  }

  /** Поддержка вернула звёзды или повторила выдачу: действие уже выполнено и записано. Упавший слушатель не мешает остальным. */
  emitSupport(action: SupportAction): Promise<void> {
    return this.emit(this.support, action, { purchaseId: action.purchase.purchaseId });
  }

  /** Звёзды вернулись по нашему заказу (Р209), впервые. Упавший слушатель не мешает остальным. */
  emitRefundDone(event: RefundDone): Promise<void> {
    return this.emit(this.refundDone, event, { purchaseId: event.purchase.purchaseId });
  }

  /** Сверка нашла новые расхождения (Р209): уже записаны. Упавший слушатель не мешает остальным и самой сверке. */
  emitReconcileFound(event: ReconcileFound): Promise<void> {
    return this.emit(this.reconcileFound, event, { platform: event.platform });
  }

  emitSubscriptionChanged(change: SubscriptionChange): Promise<void> {
    return this.emit(this.subscriptions, change, { purchaseId: change.subscription.purchaseId });
  }

  /** `subject` — по чему искать событие в логе, если слушатель упал: покупка или задание. */
  private emit<T>(listeners: readonly { name: string; listener: (event: T) => Promise<void> }[], event: T, subject: Record<string, string>): Promise<void> {
    return Promise.all(
      listeners.map(async ({ name, listener }) => {
        try {
          await listener(event);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "payments",
              event: "listener_failed",
              listener: name,
              ...subject,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }
}
