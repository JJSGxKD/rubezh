import type { PlatformId } from "./platform.js";

/**
 * Оплата через площадку (docs/35-stage4-plan.md, §3.11): счёт, ответ на
 * предварительную проверку и возврат. Что продаётся и по какой цене, решает
 * домен; как площадка выставляет счёт, принимает деньги и возвращает их,
 * знает только её адаптер.
 *
 * Обратная сторона — что площадка сообщает об оплате: проверка перед
 * оплатой, подтверждение, возврат по её инициативе. Эти события адаптер
 * переводит в вызовы домена сам (у Telegram — обработчик обновлений бота),
 * поэтому в порту их нет.
 */

/** Что игрок видит в окне оплаты площадки. */
export interface ProviderInvoice {
  title: string;
  description: string;
  /** вернётся в подтверждении — по нему домен находит покупку */
  payload: string;
  /** подпись позиции счёта */
  label: string;
  /** сумма в единицах валюты площадки: у звёзд — звёзды */
  amount: number;
}

/** Ответ на проверку перед оплатой: отказ показывается игроку этим текстом. */
export type CheckoutAnswer = { ok: true } | { ok: false; errorMessage: string };

/** Площадка не выставила счёт — повтор может помочь. */
export class PaymentProviderUnavailableError extends Error {
  override readonly name = "PaymentProviderUnavailableError";
}

/** Площадка отказала окончательно — повтор не поможет, разбирается человеком. */
export class PaymentProviderRejectedError extends Error {
  override readonly name = "PaymentProviderRejectedError";
}

export interface PaymentProvider {
  readonly platform: PlatformId;
  /** валюта оплаты площадки: у Telegram — звёзды, `XTR` */
  readonly currency: string;
  /**
   * Площадка может сообщить нам об оплате. Без этого продавать нельзя:
   * деньги спишутся, а право на товар не появится — его выдаёт подтверждение
   * (docs/34-stage3-plan.md, Р13).
   */
  readonly confirms: boolean;
  /** может ли этот игрок платить на площадке: аккаунт разработчика, например, не может */
  accepts(platformUserId: string): boolean;
  /** ссылка на счёт; не выставился — `PaymentProviderUnavailableError` */
  createInvoice(invoice: ProviderInvoice): Promise<string>;
  answerCheckout(queryId: string, answer: CheckoutAnswer): Promise<void>;
  /**
   * Вернуть оплату. Уже возвращённая — не ошибка. Окончательный отказ —
   * `PaymentProviderRejectedError`; прочие ошибки — временные, их повторяют.
   */
  refund(payerId: string, chargeId: string): Promise<"refunded" | "already_refunded">;
}

/** Способы оплаты всех площадок: домен выбирает по площадке аккаунта. */
export class PaymentProviders {
  constructor(private readonly all: readonly PaymentProvider[]) {}

  for(platform: PlatformId): PaymentProvider | null {
    return this.all.find((provider) => provider.platform === platform) ?? null;
  }

  /** есть площадка, которая сообщит об оплате, — продажу есть смысл включать */
  get anyConfirms(): boolean {
    return this.all.some((provider) => provider.confirms);
  }
}
