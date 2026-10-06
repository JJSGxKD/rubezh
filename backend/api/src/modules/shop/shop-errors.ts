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

/** Срок акции вне пределов честной скидки (`shop-promo-rules.ts`). */
export class PromoPeriodError extends DomainError {
  constructor(message: string) {
    super("promo_period", message, 400);
  }
}

/** Рядом по времени у товара другая акция: полная цена между ними не простоит положенного. */
export class PromoOverlapError extends DomainError {
  constructor(message: string) {
    super("promo_overlap", message, 409);
  }
}

/** Акции нет, или она уже кончилась или снята — панель перечитывает список. */
export class PromoNotFoundError extends DomainError {
  constructor() {
    super("promo_not_found", "Акции нет, или она уже кончилась", 404);
  }
}
