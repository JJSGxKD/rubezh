import { PaymentProviders } from "../../src/platforms/ports/payment-provider.js";
import type { PreCheckoutAnswer, StarsInvoice } from "../../src/platforms/telegram/telegram-bot-api.js";
import { TelegramStarsProvider, type StarsBotApi } from "../../src/platforms/telegram/telegram-stars-provider.js";

/**
 * Bot API оплаты звёздами в памяти. Домен оплаты проверяется через
 * настоящий адаптер Telegram поверх этой подделки: так разбор ответов Bot
 * API — «уже возвращено», окончательный отказ, сбой сети — остаётся под теми
 * же тестами, что и до порта.
 */
export class FakeStarsApi implements StarsBotApi {
  readonly sent: StarsInvoice[] = [];
  readonly answers: { queryId: string; answer: PreCheckoutAnswer }[] = [];
  readonly refunded: { userId: number; chargeId: string }[] = [];
  invoiceFailWith: Error | null = null;
  refundFailWith: Error | null = null;

  async createInvoiceLink(invoice: StarsInvoice): Promise<string> {
    if (this.invoiceFailWith !== null) throw this.invoiceFailWith;
    this.sent.push(invoice);
    return `https://t.me/$invoice-${this.sent.length}`;
  }

  async answerPreCheckoutQuery(queryId: string, answer: PreCheckoutAnswer): Promise<void> {
    this.answers.push({ queryId, answer });
  }

  async refundStarPayment(userId: number, chargeId: string): Promise<void> {
    if (this.refundFailWith !== null) throw this.refundFailWith;
    this.refunded.push({ userId, chargeId });
  }
}

/** Оплата только звёздами, бот читает обновления — как в проде с включённой продажей. */
export function starsProviders(api: StarsBotApi = new FakeStarsApi(), confirms = true): PaymentProviders {
  return new PaymentProviders([new TelegramStarsProvider(api, confirms)]);
}
