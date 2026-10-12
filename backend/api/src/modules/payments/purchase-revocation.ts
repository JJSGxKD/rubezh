import { Injectable } from "@nestjs/common";
import type { PurchaseProduct, StoredPurchase } from "./purchase-types.js";

/**
 * Кто забирает остаток покупки при возврате звёзд (docs/35-stage4-plan.md
 * §3.6, tasks/T-0023). Модуль оплаты не знает ни кошелька, ни VIP: хозяин
 * товара регистрирует здесь свой отзыв, как уже регистрирует выдачу в
 * `PurchaseFulfillment`.
 *
 * Отзыв обязан быть идемпотентным: его зовёт обработка возврата, и она
 * повторяется при каждом вызове, пока не пройдёт целиком, — а не только в
 * первый раз. Ошибка отзыва пробивается наружу: задание очереди оплаты
 * повторит обработку.
 */

/** Что забрано при возврате — строками для лога и карточки команде: «самоцветы: 120 из 150». */
export interface Revocation {
  lines: string[];
}

export type Revoker = (purchase: StoredPurchase, at: Date) => Promise<Revocation>;

@Injectable()
export class PurchaseRevocation {
  private readonly revokers = new Map<PurchaseProduct, Revoker>();

  /**
   * Повторная регистрация того же вида — ошибка: два отзыва одного товара
   * забрали бы дважды. У выдачи такой проверки нет, а здесь она нужна.
   */
  register(product: PurchaseProduct, revoker: Revoker): void {
    if (this.revokers.has(product)) throw new Error(`отзыв ${product} уже зарегистрирован`);
    this.revokers.set(product, revoker);
  }

  /** Владельца нет — забирать нечего: второй шанс использован в момент покупки. */
  async revoke(purchase: StoredPurchase, at: Date): Promise<Revocation> {
    const revoker = this.revokers.get(purchase.product);
    if (revoker === undefined) return { lines: ["ничего — товар не забирается"] };
    return await revoker(purchase, at);
  }
}
