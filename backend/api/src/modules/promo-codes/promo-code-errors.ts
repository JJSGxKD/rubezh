import { DomainError } from "../../common/domain-error.js";
import type { RedeemRefusal } from "./promo-code-rules.js";

/**
 * Ошибки промокодов. Игроку — по коду (`promo_code_*`): клиент знает текст
 * каждого отказа сам, а сообщение здесь — для логов и старых клиентов.
 * Префикс не `promo_` — так уже называются ошибки акций магазина.
 */

/**
 * Кода нет. Неверный по форме код отвечает тем же: перебору незачем знать,
 * что формы кодов разные.
 */
export class PromoCodeNotFoundError extends DomainError {
  constructor() {
    super("promo_code_not_found", "Такого кода нет — проверьте, нет ли опечатки", 404);
  }
}

const REFUSAL_MESSAGES: Record<RedeemRefusal, string> = {
  already: "Награду по этому коду вы уже получили",
  scheduled: "Код ещё не начал действовать",
  paused: "Код сейчас не действует",
  expired: "Срок действия кода закончился",
  exhausted: "Код уже активировали максимальное число раз",
  used: "Этот код уже активировали",
  platform: "Код не действует на этой площадке",
  new_players: "Код только для новых игроков",
};

export class PromoCodeRefusedError extends DomainError {
  constructor(readonly reason: RedeemRefusal) {
    super(`promo_code_${reason}`, REFUSAL_MESSAGES[reason], 409);
  }
}

/** Кампании нет — панель перечитывает список. */
export class PromoCampaignNotFoundError extends DomainError {
  constructor() {
    super("promo_campaign_not_found", "Промокода нет — возможно, его удалили", 404);
  }
}

/** Срок, лимит или награда вне правил (`promo-code-rules.ts`). */
export class PromoCampaignInvalidError extends DomainError {
  constructor(message: string) {
    super("promo_campaign_invalid", message, 400);
  }
}

/** Код уже занят другой кампанией — коды не переиспользуются, чтобы старый пост не начал давать новую награду. */
export class PromoCodeTakenError extends DomainError {
  constructor(display: string, title: string) {
    super("promo_code_taken", `Код ${display} уже занят — «${title}». Придумайте другой`, 409);
  }
}

/** Удалить нельзя: по коду уже выданы награды — его можно поставить на паузу. */
export class PromoCampaignUsedError extends DomainError {
  constructor(redeemed: number) {
    super("promo_campaign_used", `Код уже активировали ${String(redeemed)} раз — удалить нельзя, поставьте на паузу`, 409);
  }
}
