import { pluralRu } from "../../common/card/labels.js";
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

/** Сколько знаков имени получателя идёт в описание счёта: у площадки оно до 255 знаков, а в тестовом режиме перед ним ещё пояснение. */
const GIFT_RECIPIENT_NAME_MAX = 48;

/**
 * Текст счёта на VIP в подарок (Р155, T-0249): название короткое, как требует площадка, а кому
 * подарок — в описании, чтобы игрок видел, за что платит.
 */
export function vipGiftInvoiceText(title: string, recipientName: string, days: number): ShopInvoiceText {
  const name = [...recipientName.trim()].slice(0, GIFT_RECIPIENT_NAME_MAX).join("");
  return { title, description: `VIP на ${String(days)} ${pluralRu(days, "день", "дня", "дней")} в подарок — ${name === "" ? "другу" : name}` };
}
