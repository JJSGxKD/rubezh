import { DomainError } from "../../common/domain-error.js";

/** VIP уже идёт и продлевается: второй подписки не нужно — клиент показывает, до какого числа. */
export class VipActiveError extends DomainError {
  constructor() {
    super("vip_active", "VIP уже подключён и продлевается", 409);
  }
}

/** Самоцветы дня — только пока VIP идёт. */
export class VipInactiveError extends DomainError {
  constructor() {
    super("vip_inactive", "VIP не подключён", 409);
  }
}

/**
 * Вернуть продление нашей кнопкой нельзя: отменяли не мы, а игрок на площадке
 * (вернуть может только он там же), или оплаченный период уже кончился.
 */
export class VipResumeUnavailableError extends DomainError {
  constructor() {
    super("vip_resume_unavailable", "Продление не вернуть отсюда — включите его там, где оплачивали, или оформите VIP заново", 409);
  }
}
