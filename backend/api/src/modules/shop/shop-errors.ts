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

/** Предложения витрины нет у этого игрока — клиент перечитывает витрину. */
export class ShowcaseOfferNotFoundError extends DomainError {
  constructor() {
    super("showcase_offer_not_found", "Такого предложения на витрине нет", 404);
  }
}

/** Предложение вчерашних суток: витрина уже обновилась. */
export class ShowcaseExpiredError extends DomainError {
  constructor() {
    super("showcase_expired", "Витрина обновилась — посмотрите, что на ней сегодня", 409);
  }
}

/** Предложение уже куплено — с другой вкладки или повтором после обрыва. */
export class ShowcaseSoldError extends DomainError {
  constructor() {
    super("showcase_sold", "Этот предмет уже куплен", 409);
  }
}
