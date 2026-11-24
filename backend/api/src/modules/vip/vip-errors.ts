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
    super("vip_resume_unavailable", "Продление не вернуть отсюда — включи его там, где оплачивали, или оформи VIP заново", 409);
  }
}

/**
 * Подарить VIP можно только другу (Р155). Так же отвечаем про игрока, которого нет: по ответу не
 * должно быть видно, существует ли такой публичный id.
 */
export class VipGiftNotFriendError extends DomainError {
  constructor() {
    super("vip_gift_not_friend", "VIP можно подарить только другу из твоего списка друзей", 409);
  }
}

/** Себе VIP в подарок не нужен: у него свой заказ. */
export class VipGiftSelfError extends DomainError {
  constructor() {
    super("vip_gift_self", "Себе VIP в подарок не оформить — возьми его в магазине", 409);
  }
}

/** Получатель заблокирован: подарок ему не дойдёт. Называется только другу, чужим отвечает `vip_gift_not_friend`. */
export class VipGiftBlockedError extends DomainError {
  constructor() {
    super("vip_gift_blocked", "Этому игроку подарить VIP сейчас нельзя", 409);
  }
}
