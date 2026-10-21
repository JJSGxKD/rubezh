import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { FeatureSwitches } from "../settings/feature-switches.js";
import { withTimeout } from "../../common/with-timeout.js";
import { PaymentProviders } from "../../platforms/ports/payment-provider.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { RestrictionsService } from "../restrictions/restrictions.service.js";
import { answerOf, decideCheckout, isRenewal, refuse, type CheckoutDecision, type PreCheckout } from "./checkout-answer.js";
import { PaymentsHooks, type SubscriptionState } from "./payments-hooks.js";
import { PurchaseRevocation } from "./purchase-revocation.js";
import { SUBSCRIPTION_PRODUCTS } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type CheckoutView, type ConfirmOutcome, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Что площадка сообщает об оплате (docs/34-stage3-plan.md, WP5, п. 6–8):
 * предварительная проверка, подтверждение и возврат. Сообщения приносит
 * адаптер площадки (у Telegram — `platforms/telegram/telegram-payments.handler.ts`).
 *
 * **Право на продолжение появляется здесь**, при подтверждении от площадки, —
 * не раньше (Р13). Подтверждение идемпотентно по идентификатору оплаты:
 * повтор обновления ничего не удваивает.
 *
 * **Подписку** (Р20) площадка продлевает сама — очередной оплатой по счёту
 * первой покупки. Вторая оплата одного счёта у подписки — продление, а не
 * лишняя: она записывается своей строкой и не возвращается.
 */

/** Оплата, которую подтвердила площадка. */
export interface ConfirmedPayment {
  platform: PlatformId;
  chargeId: string;
  /** то, что стояло в счёте, — id покупки */
  payload: string;
  /** кто платил — ему же вернутся деньги, если придётся */
  payerId: string;
  currency: string;
  totalAmount: number;
}

/** Что площадка сообщила о продлении подписки. */
export interface SubscriptionUpdate {
  platform: PlatformId;
  /** то, что стояло в счёте, — id первой покупки подписки */
  payload: string;
  /** чья подписка — идентификатор на площадке */
  payerId: string;
  state: SubscriptionState;
}

/**
 * Чтение покупки для предварительной проверки. Весь ответ Telegram ждёт
 * десять секунд — у других площадок сроки не длиннее, — и отказ «попробуйте
 * ещё раз» лучше сорванной оплаты без объяснений.
 */
const CHECKOUT_READ_TIMEOUT_MS = 3_000;

const purchaseId = z.uuid();

@Injectable()
export class PaymentConfirmation {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    private readonly providers: PaymentProviders,
    private readonly switches: FeatureSwitches,
    // Слушатели нужны модулю, а не каждому тесту подтверждения: без них — пустой список.
    private readonly hooks: PaymentsHooks = new PaymentsHooks(),
    // То же с отзывом: без владельцев товаров возврат только записывается.
    private readonly revocation: PurchaseRevocation = new PurchaseRevocation(),
    // Закрытие покупок после внешнего возврата (T-0024). Без них, как в тестах, где ограничений нет,
    // возврат только записывается и отзывает остаток, а предварительная проверка не спрашивает про покупки.
    private readonly restrictions?: AccountRestrictions,
    private readonly system?: RestrictionsService,
  ) {}

  async answerCheckout(query: PreCheckout, nowMs = Date.now()): Promise<CheckoutDecision> {
    const provider = this.providers.for(query.platform);
    // Проверка пришла от площадки, у которой нет оплаты: ответить ей нечем.
    if (provider === null) {
      this.log("error", "pre_checkout_unsupported", { platform: query.platform, purchaseId: query.payload });
      return refuse("unavailable");
    }
    const decision = await this.decide(query, nowMs);
    await provider.answerCheckout(query.queryId, answerOf(decision));
    this.log(decision.ok ? "log" : "warn", "pre_checkout", {
      platform: query.platform,
      purchaseId: query.payload,
      payerId: query.payerId,
      ok: decision.ok,
      ...(decision.ok ? {} : { reason: decision.reason }),
    });
    return decision;
  }

  async confirm(payment: ConfirmedPayment, nowMs = Date.now()): Promise<ConfirmOutcome> {
    const id = purchaseId.safeParse(payment.payload);
    let outcome: ConfirmOutcome = id.success
      ? await this.purchases.markPaid({ purchaseId: id.data, chargeId: payment.chargeId, chargedStars: payment.totalAmount, paidAt: new Date(nowMs) })
      : { kind: "unknown" };
    if (outcome.kind === "already_paid" && SUBSCRIPTION_PRODUCTS.includes(outcome.purchase.product)) {
      outcome = await this.purchases.markRenewal({
        firstId: outcome.purchase.purchaseId,
        purchaseId: randomUUID(),
        chargeId: payment.chargeId,
        chargedStars: payment.totalAmount,
        paidAt: new Date(nowMs),
      });
    }

    const fields = { platform: payment.platform, chargeId: payment.chargeId, purchaseId: payment.payload, payerId: payment.payerId, amount: payment.totalAmount };
    switch (outcome.kind) {
      case "paid":
        this.log("log", "payment_confirmed", { ...fields, product: outcome.purchase.product, runId: outcome.purchase.runId, renewalOf: outcome.purchase.renewalOf, mode: outcome.purchase.mode });
        void this.hooks.emitPaid({
          purchaseId: outcome.purchase.purchaseId,
          accountId: outcome.purchase.accountId,
          product: outcome.purchase.product,
          mode: outcome.purchase.mode,
          at: new Date(nowMs),
        });
        break;
      case "duplicate":
        this.log("log", "payment_duplicate_update", fields);
        break;
      case "already_paid":
        // Игрок заплатил за одно продолжение дважды: проверка пропустила обе
        // оплаты, пока ни одна не была подтверждена. Вторая вернётся
        // (`payment-refunds.ts`), но так быть не должно — отсюда ошибка.
        this.log("error", "payment_twice", { ...fields, firstChargeId: outcome.purchase.telegramChargeId });
        break;
      case "unknown":
        // Проверка не пускает оплату без покупки, так что это потерянная база
        // или чужой счёт от нашего бота. Звёзды вернутся, а разбираться, как
        // так вышло, — человеку.
        this.log("error", "payment_unmatched", fields);
        break;
    }
    return outcome;
  }

  /**
   * Деньги вернулись игроку — по нашему заказу или по его спору на площадке.
   *
   * Внешний возврат забирает то, что осталось от покупки (tasks/T-0023,
   * решение 06.10.2026): иначе схема «купил → потратил → вернул» открыта.
   * Наши возвраты ничего не забирают: товар либо не выдавался
   * (`undeliverable`), либо выдан по первой оплате (лишняя оплата).
   *
   * Отзыв — при **каждом** вызове, до проверки `firstTime`: первая попытка
   * могла отметить возврат и упасть на отзыве, и повтор обязан его доделать.
   * Ошибка отзыва бросается дальше — задание очереди оплаты повторит
   * обработку. Момент отзыва — когда возврат отмечен впервые, а не когда
   * повторили: срок VIP режется по одному и тому же времени.
   *
   * После отзыва аккаунту закрываются покупки (ограничение «Покупки»,
   * tasks/T-0024) и команде уходит карточка. Это тоже обязано пережить сбой
   * посреди: первая попытка могла отметить возврат и упасть на закрытии, а
   * повтор уже не «первый». Поэтому повтор закрывает и шлёт карточку, если
   * аккаунт ещё открыт; закрытому он ничего не делает — повторное обновление
   * площадки не накладывает второе ограничение и не шлёт вторую карточку.
   */
  async refunded(chargeId: string, nowMs = Date.now()): Promise<void> {
    const record = await this.purchases.markRefunded(chargeId, new Date(nowMs));
    if (record === null) {
      this.log("warn", "refund_unmatched", { chargeId });
      return;
    }
    const { purchase } = record;
    const external = purchase.refundReason === "external";
    const at = purchase.refundedAt ?? new Date(nowMs);
    const revocation = external ? await this.revocation.revoke(purchase, at) : null;
    const closing = external && this.system !== undefined && (record.firstTime || !(await this.accountClosed(purchase.accountId, at)));
    if (!record.firstTime && !closing) return;
    // Доля возвратов на аккаунт — вход для решения О4: правило появится, когда
    // появятся первые случаи, а счётчик нужен с первого.
    const stats = external ? await this.purchases.refundStats(purchase.accountId) : null;
    if (closing) {
      await this.system?.imposeBySystem(purchase.accountId, "purchases", "payment_refund", `Возврат звёзд за покупку ${purchase.purchaseId}`, at);
    }
    this.log(external ? "warn" : "log", "payment_refunded", {
      chargeId,
      purchaseId: purchase.purchaseId,
      accountId: purchase.accountId,
      reason: purchase.refundReason,
      mode: purchase.mode,
      ...(stats === null ? {} : { accountPaid: stats.paid, accountRefunded: stats.refunded }),
      ...(revocation === null ? {} : { revoked: revocation.lines }),
    });
    if (closing && revocation !== null && stats !== null) await this.hooks.emitExternalRefund({ purchase, revoked: revocation.lines, stats, at });
  }

  /**
   * Закрыты ли покупки аккаунту, который платит. Продление подписки пропускается без вопроса: оно
   * проходит в любом случае, и сбой чтения ограничений не должен отказать в нём.
   */
  private async purchasesClosed(view: CheckoutView | null, nowMs: number): Promise<boolean> {
    if (view === null || this.restrictions === undefined || isRenewal(view.purchase)) return false;
    return await this.accountClosed(view.purchase.accountId, new Date(nowMs));
  }

  private async accountClosed(accountId: string, at: Date): Promise<boolean> {
    if (this.restrictions === undefined) return false;
    return (await withTimeout(this.restrictions.status(accountId, "purchases", at), CHECKOUT_READ_TIMEOUT_MS, "ограничения для проверки оплаты")) !== null;
  }

  /**
   * Площадка сообщила о продлении подписки: игрок отменил его или вернул у
   * себя, или очередное списание не прошло. Чужая или неизвестная подписка —
   * в лог: сообщение пришло от нашего бота, но сверить его не с чем.
   */
  async subscriptionChanged(update: SubscriptionUpdate, nowMs = Date.now()): Promise<void> {
    const id = purchaseId.safeParse(update.payload);
    const view = id.success ? await this.purchases.checkout(id.data, new Date(nowMs)) : null;
    const fields = { platform: update.platform, purchaseId: update.payload, payerId: update.payerId, state: update.state };
    if (view === null || !SUBSCRIPTION_PRODUCTS.includes(view.purchase.product) || view.platformUserId !== update.payerId) {
      this.log("warn", "subscription_unmatched", fields);
      return;
    }
    this.log("log", "subscription_changed", { ...fields, accountId: view.purchase.accountId });
    await this.hooks.emitSubscriptionChanged({ subscription: view.purchase, state: update.state, at: new Date(nowMs) });
  }

  private async decide(query: PreCheckout, nowMs: number): Promise<CheckoutDecision> {
    const id = purchaseId.safeParse(query.payload);
    if (!id.success) return decideCheckout(null, query, nowMs, this.switches.payments());
    try {
      const view = await withTimeout(this.purchases.checkout(id.data, new Date(nowMs)), CHECKOUT_READ_TIMEOUT_MS, "покупка для проверки оплаты");
      return decideCheckout(view, query, nowMs, this.switches.payments(), await this.purchasesClosed(view, nowMs));
    } catch (error: unknown) {
      // База не ответила — отказываемся от денег, а не берём их вслепую.
      this.log("error", "pre_checkout_failed", { purchaseId: id.data, reason: error instanceof Error ? error.message : "unknown" });
      return refuse("unavailable");
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}
