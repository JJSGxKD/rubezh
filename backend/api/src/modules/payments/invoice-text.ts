import type { ProviderInvoice } from "../../platforms/ports/payment-provider.js";
import { startedMinutes } from "./continue-price.js";
import type { PaymentMode } from "./purchase-types.js";

/**
 * Что игрок видит в окне оплаты площадки. Окно рисует площадка, а не игра,
 * поэтому тестовую оплату приходится называть прямо здесь: иначе через месяц
 * никто не вспомнит, почему продолжение на двадцатой минуте стоило одну
 * звезду (docs/34-stage3-plan.md, Р14).
 */

export interface ContinueInvoiceInput {
  purchaseId: string;
  elapsedSec: number;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
}

const LABEL = "Второй шанс";

export function continueInvoice(input: ContinueInvoiceInput): ProviderInvoice {
  const minute = startedMinutes(input.elapsedSec);
  if (input.mode === "test") {
    return {
      title: "Второй шанс — тест",
      description: `Тестовая оплата: списывается ${input.chargedStars} ⭐ и сразу возвращается. Настоящая цена — ${input.priceStars} ⭐.`,
      payload: input.purchaseId,
      label: LABEL,
      amount: input.chargedStars,
    };
  }
  return {
    title: LABEL,
    description: `Продолжить забег с ${minute}-й минуты: враги уходят с поля, здоровье возвращается.`,
    payload: input.purchaseId,
    label: LABEL,
    amount: input.chargedStars,
  };
}

/** Название и описание товара магазина — их пишет магазин по каталогу. */
export interface ShopInvoiceText {
  title: string;
  description: string;
}

export interface ShopInvoiceInput {
  purchaseId: string;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
  text: ShopInvoiceText;
}

export function shopInvoice(input: ShopInvoiceInput): ProviderInvoice {
  if (input.mode === "test") {
    return {
      title: `${input.text.title} — тест`,
      description: `Тестовая оплата: списывается ${input.chargedStars} ⭐ и сразу возвращается. Настоящая цена — ${input.priceStars} ⭐. ${input.text.description}`,
      payload: input.purchaseId,
      label: input.text.title,
      amount: input.chargedStars,
    };
  }
  return { title: input.text.title, description: input.text.description, payload: input.purchaseId, label: input.text.title, amount: input.chargedStars };
}
