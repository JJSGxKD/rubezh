import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";
import { answerOf, decideCheckout, refuse, type CheckoutDecision, type PreCheckout } from "./checkout-answer.js";
import { PURCHASES_REPOSITORY, type ConfirmOutcome, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Что Telegram сообщает об оплате (docs/34-stage3-plan.md, WP5, п. 6–8):
 * предварительная проверка, подтверждение и возврат.
 *
 * **Право на продолжение появляется здесь**, при подтверждении от Telegram, —
 * не раньше (Р13). Подтверждение идемпотентно по идентификатору оплаты:
 * повтор обновления ничего не удваивает.
 */

/** Оплата, которую подтвердил Telegram. */
export interface ConfirmedPayment {
  chargeId: string;
  /** то, что стояло в счёте, — id покупки */
  payload: string;
  /** кто платил — ему же вернутся звёзды, если придётся */
  userId: number;
  currency: string;
  totalAmount: number;
}

/**
 * Чтение покупки для предварительной проверки. Весь ответ Telegram ждёт
 * десять секунд, и отказ «попробуйте ещё раз» лучше сорванной оплаты без
 * объяснений.
 */
const CHECKOUT_READ_TIMEOUT_MS = 3_000;

const purchaseId = z.uuid();

export type ConfirmationBotApi = Pick<TelegramBotApi, "answerPreCheckoutQuery">;

@Injectable()
export class PaymentConfirmation {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    @Inject(TELEGRAM_BOT_API) private readonly api: ConfirmationBotApi,
  ) {}

  async answerCheckout(query: PreCheckout, nowMs = Date.now()): Promise<CheckoutDecision> {
    const decision = await this.decide(query, nowMs);
    await this.api.answerPreCheckoutQuery(query.queryId, answerOf(decision));
    this.log(decision.ok ? "log" : "warn", "pre_checkout", {
      purchaseId: query.payload,
      userId: query.fromUserId,
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

    const fields = { chargeId: payment.chargeId, purchaseId: payment.payload, userId: payment.userId, stars: payment.totalAmount };
    switch (outcome.kind) {
      case "paid":
        this.log("log", "payment_confirmed", { ...fields, runId: outcome.purchase.runId, mode: outcome.purchase.mode });
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

  /** Звёзды вернулись игроку — по нашему заказу или по его спору в Telegram. */
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
