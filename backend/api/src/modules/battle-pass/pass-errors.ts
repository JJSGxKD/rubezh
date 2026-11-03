import { DomainError } from "../../common/domain-error.js";

/** Очков пока не хватает до этой ступени (или такой ступени нет): клиент перечитывает пасс. */
export class PassTierNotReachedError extends DomainError {
  constructor() {
    super("pass_tier_not_reached", "Эта ступень ещё не достигнута", 409);
  }
}

/** Награда ступени этой ленты уже забрана: повтор ничего не начисляет. */
export class PassAlreadyClaimedError extends DomainError {
  constructor() {
    super("pass_already_claimed", "Эта награда уже забрана", 409);
  }
}

/** VIP-лента открыта только при активном VIP — на момент забора, а не на момент ступени. */
export class PassVipRequiredError extends DomainError {
  constructor() {
    super("pass_vip_required", "Награды VIP-ленты доступны с VIP", 409);
  }
}
