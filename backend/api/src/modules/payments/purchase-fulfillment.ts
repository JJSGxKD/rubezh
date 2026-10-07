import { Injectable } from "@nestjs/common";
import type { PurchaseProduct, StoredPurchase } from "./purchase-types.js";

/**
 * Кто выдаёт оплаченное (docs/35-stage4-plan.md §3.6, WP10). Второй шанс
 * выдаёт сама оплата: право на продолжение — строка с `paid_at`. Товар
 * магазина кладёт на счёт игрока магазин — модуль оплаты о каталоге не
 * знает, поэтому хозяин товара регистрирует здесь свою выдачу.
 *
 * Выдача обязана быть идемпотентной — ключом покупки в журнале кошелька: её
 * зовёт задание подтверждения оплаты, и упавшее задание повторяется целиком.
 */
export type Fulfiller = (purchase: StoredPurchase) => Promise<void>;

/**
 * Выдача невозможна по сути: товара больше нет в каталоге. Повторять бесполезно
 * — проход довыдачи возвращает за такую покупку звёзды, а не пробует снова.
 * Любая другая ошибка выдачи — временная или в коде: решает человек.
 */
export class UndeliverableError extends Error {
  override readonly name = "UndeliverableError";
}

@Injectable()
export class PurchaseFulfillment {
  private readonly fulfillers = new Map<PurchaseProduct, Fulfiller>();

  register(product: PurchaseProduct, fulfiller: Fulfiller): void {
    this.fulfillers.set(product, fulfiller);
  }

  /** Товары, у которых есть выдача: только их покупки проход довыдачи подбирает. */
  products(): PurchaseProduct[] {
    return [...this.fulfillers.keys()];
  }

  /** `false` — выдавать нечего: у товара нет выдачи сверх оплаты. */
  async fulfill(purchase: StoredPurchase): Promise<boolean> {
    const fulfiller = this.fulfillers.get(purchase.product);
    if (fulfiller === undefined) return false;
    await fulfiller(purchase);
    return true;
  }
}
