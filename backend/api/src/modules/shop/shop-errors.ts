import { DomainError } from "../../common/domain-error.js";

/** Такого товара в каталоге нет — клиент перечитывает витрину. */
export class ShopSkuNotFoundError extends DomainError {
  constructor() {
    super("shop_sku_not_found", "Такого товара нет", 404);
  }
}

/** Способ оплаты этот товар не продаёт: цена вне его пределов или без курса. */
export class ShopSkuUnavailableError extends DomainError {
  constructor() {
    super("shop_sku_unavailable", "Этот товар сейчас не купить", 409);
  }
}
