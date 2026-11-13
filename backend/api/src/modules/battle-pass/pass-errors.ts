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

/** Месяц без своей ленты: править нечего, сначала её заводят. */
export class PassSeasonNotFoundError extends DomainError {
  constructor() {
    super("pass_season_not_found", "У этого месяца ещё нет своей ленты: её нужно создать", 404);
  }
}

/** Лента месяца уже заведена: второе «создать» не затирает правки. */
export class PassSeasonExistsError extends DomainError {
  constructor() {
    super("pass_season_exists", "Лента этого месяца уже заведена", 409);
  }
}

/** Прошлые месяцы — только чтение: по ним игроки уже получили награды. */
export class PassSeasonReadonlyError extends DomainError {
  constructor() {
    super("pass_season_readonly", "Прошлый месяц только для чтения", 409);
  }
}

/** Ступень текущего месяца, до которой уже дошёл игрок: награду задним числом не меняют. */
export class PassTierPassedError extends DomainError {
  constructor(message = "Эту ступень уже прошли игроки") {
    super("pass_tier_passed", message, 409);
  }
}

/** Ленту параллельно изменил другой администратор: панель перечитывает месяц. */
export class PassSeasonChangedError extends DomainError {
  constructor() {
    super("pass_season_changed", "Ленту только что изменили: страницу нужно обновить", 409);
  }
}

/** Лента в базе не проходит схему (правили руками): панель не покажет её как есть. */
export class PassSeasonBrokenError extends DomainError {
  constructor(problem: string) {
    super("pass_season_broken", `Лента месяца в базе не проходит проверку: ${problem}`, 409);
  }
}
