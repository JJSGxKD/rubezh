import {
  PaymentProviderRejectedError,
  PaymentProviderUnavailableError,
  type CheckoutAnswer,
  type PaymentProvider,
  type ProviderInvoice,
} from "../ports/payment-provider.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Оплата Telegram Stars (docs/34-stage3-plan.md, WP5). Цифровые товары в
 * Mini App продаются только за звёзды (`08-web-and-identity.md` §6), поэтому
 * у Telegram способ оплаты один.
 *
 * Здесь — всё, что знает о Telegram: как выглядит счёт, как понять по ответу
 * Bot API, что возврат уже сделан или не пройдёт никогда. Домен получает
 * ошибки порта, а не `TelegramApiError`.
 */

export type StarsBotApi = Pick<TelegramBotApi, "createInvoiceLink" | "answerPreCheckoutQuery" | "refundStarPayment" | "editUserStarSubscription">;

/** Подписка Stars — только на 30 суток: другой период Bot API не принимает. */
export const STARS_SUBSCRIPTION_PERIOD_SEC = 30 * 24 * 60 * 60;

/** Telegram уже вернул эти звёзды: повтор возврата — не ошибка. */
const ALREADY_REFUNDED = /CHARGE_ALREADY_REFUNDED/i;

/** Telegram ID — число; аккаунт разработчика (`dev-…`) платить не может: у него нет звёзд. */
const TELEGRAM_USER_ID = /^\d{1,20}$/;

export class TelegramStarsProvider implements PaymentProvider {
  readonly platform = "telegram" as const;
  readonly currency = "XTR";
  readonly subscriptionPeriodSec = STARS_SUBSCRIPTION_PERIOD_SEC;

  /** @param confirms бот читает обновления — иначе подтверждение оплаты не придёт */
  constructor(
    private readonly api: StarsBotApi,
    readonly confirms: boolean,
  ) {}

  accepts(platformUserId: string): boolean {
    return TELEGRAM_USER_ID.test(platformUserId);
  }

  async createInvoice(invoice: ProviderInvoice): Promise<string> {
    try {
      return await this.api.createInvoiceLink({
        title: invoice.title,
        description: invoice.description,
        payload: invoice.payload,
        label: invoice.label,
        stars: invoice.amount,
        ...(invoice.subscriptionPeriodSec === undefined ? {} : { subscriptionPeriodSec: invoice.subscriptionPeriodSec }),
      });
    } catch (error: unknown) {
      if (error instanceof TelegramApiError) throw new PaymentProviderUnavailableError(error.message);
      throw error;
    }
  }

  async answerCheckout(queryId: string, answer: CheckoutAnswer): Promise<void> {
    await this.api.answerPreCheckoutQuery(queryId, answer);
  }

  async refund(payerId: string, chargeId: string): Promise<"refunded" | "already_refunded"> {
    try {
      await this.api.refundStarPayment(Number(payerId), chargeId);
      return "refunded";
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      if (ALREADY_REFUNDED.test(error.message)) return "already_refunded";
      // Сеть, `429` и сбои Telegram проходят сами — повтор с паузой. Прочие
      // `400` не пройдут никогда: это разбор для человека, а не для очереди.
      if (error.errorCode === 400) throw new PaymentProviderRejectedError(error.message);
      throw error;
    }
  }

  async setSubscriptionRenewal(payerId: string, chargeId: string, renew: boolean): Promise<void> {
    try {
      await this.api.editUserStarSubscription(Number(payerId), chargeId, !renew);
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      // `400` — подписки нет, она уже кончилась или продление отменил сам
      // игрок: вернуть его может только он. Повтор тут не поможет.
      if (error.errorCode === 400) throw new PaymentProviderRejectedError(error.message);
      throw new PaymentProviderUnavailableError(error.message);
    }
  }
}
