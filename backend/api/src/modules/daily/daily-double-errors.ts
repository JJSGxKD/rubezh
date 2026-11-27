import { DomainError } from "../../common/domain-error.js";

/**
 * Отказы удвоения награды дня за ролик (docs/35-stage4-plan.md Р155, tasks/T-0242).
 * Проверка идёт до забора досмотренной сессии, поэтому при любом из них ролик
 * не потрачен.
 */

/** Сегодняшняя награда дня не забрана — удваивать нечего; вчерашняя сгорела, копить удвоения нельзя. */
export class DailyNotClaimedError extends DomainError {
  constructor() {
    super("daily_not_claimed", "Сначала забери награду дня — удвоить можно только забранную сегодня", 409);
  }
}

/** Награду этих суток уже удвоили — раз в игровые сутки. */
export class DailyAlreadyDoubledError extends DomainError {
  constructor() {
    super("daily_already_doubled", "Награда дня за сегодня уже удвоена", 409);
  }
}
