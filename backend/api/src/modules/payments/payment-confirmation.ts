import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { PaymentProviders } from "../../platforms/ports/payment-provider.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { answerOf, decideCheckout, refuse, type CheckoutDecision, type PreCheckout } from "./checkout-answer.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PURCHASES_REPOSITORY, type ConfirmOutcome, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Что площадка сообщает об оплате (docs/34-stage3-plan.md, WP5, п. 6–8):
 * предварительная проверка, подтверждение и возврат. Сообщения приносит
 * адаптер площадки (у Telegram — `platforms/telegram/telegram-payments.handler.ts`).
 *
 * **Право на продолжение появляется здесь**, при подтверждении от площадки, —
 * не раньше (Р13). Подтверждение идемпотентно по идентификатору оплаты:
 * повтор обновления ничего не удваивает.
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
    // Слушатели нужны модулю, а не каждому тесту подтверждения: без них — пустой список.
    private readonly hooks: PaymentsHooks = new PaymentsHooks(),
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
    const outcome = id.success
      ? await this.purchases.markPaid({ purchaseId: id.data, chargeId: payment.chargeId, chargedStars: payment.totalAmount, paidAt: new Date(nowMs) })
      : ({ kind: "unknown" } as const);

    const fields = { platform: payment.platform, chargeId: payment.chargeId, purchaseId: payment.payload, payerId: payment.payerId, amount: payment.totalAmount };
    switch (outcome.kind) {
      case "paid":
        this.log("log", "payment_confirmed", { ...fields, runId: outcome.purchase.runId, mode: outcome.purchase.mode });
        void this.hooks.emitPaid({ purchaseId: outcome.purchase.purchaseId, accountId: outcome.purchase.accountId, mode: outcome.purchase.mode, at: new Date(nowMs) });
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

  /** Деньги вернулись игроку — по нашему заказу или по его спору на площадке. */
  async refunded(chargeId: string, nowMs = Date.now()): Promise<void> {
    const record = await this.purchases.markRefunded(chargeId, new Date(nowMs));
    if (record === null) {
      this.log("warn", "refund_unmatched", { chargeId });
      return;
    }
    if (!record.firstTime) return;
    const { purchase } = record;
    // Доля возвратов на аккаунт — вход для решения О4: правило появится, когда
    // появятся первые случаи, а счётчик нужен с первого.
    const stats = purchase.refundReason === "external" ? await this.purchases.refundStats(purchase.accountId) : null;
    this.log(purchase.refundReason === "external" ? "warn" : "log", "payment_refunded", {
      chargeId,
      purchaseId: purchase.purchaseId,
      accountId: purchase.accountId,
      reason: purchase.refundReason,
      mode: purchase.mode,
      ...(stats === null ? {} : { accountPaid: stats.paid, accountRefunded: stats.refunded }),
    });
  }

  private async decide(query: PreCheckout, nowMs: number): Promise<CheckoutDecision> {
    const id = purchaseId.safeParse(query.payload);
    if (!id.success) return decideCheckout(null, query, nowMs, this.config.payments.enabled);
    try {
      const view = await withTimeout(this.purchases.checkout(id.data), CHECKOUT_READ_TIMEOUT_MS, "покупка для проверки оплаты");
      return decideCheckout(view, query, nowMs, this.config.payments.enabled);
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
