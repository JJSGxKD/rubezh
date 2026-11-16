import { DomainError } from "../../../common/domain-error.js";

/** Подтверждение отчёта и выплаты (Р222, tasks/T-0469): отказы, которые видит участник и владелец. */

/** Участнику по этому месяцу уже выплачено: решение по отчёту больше не меняется, как и повтор прежнего. */
export class LedgerConfirmationPaidError extends DomainError {
  constructor(period: string) {
    super("ledger_confirmation_paid", `По месяцу ${period} тебе уже выплачено: решение по отчёту больше не меняется`, 409);
  }
}
