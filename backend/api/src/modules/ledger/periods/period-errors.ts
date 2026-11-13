import { DomainError } from "../../../common/domain-error.js";
import type { ChecklistItem } from "./checklist.js";
import type { PeriodStatus } from "./period-rules.js";

/** Месяцы учёта (Р222, tasks/T-0468): отказы, которые видит владелец, закрывающий месяц, и тот, кто пишет проводку. */

/** В закрытый месяц проводки не пишутся: поправка — в открытом месяце, а закрытие сначала снимают. */
export class LedgerPeriodClosedError extends DomainError {
  constructor(period: string) {
    super("ledger_period_closed", `Месяц ${period} закрыт: проводки в него не пишутся. Укажите дату в открытом месяце или снимите закрытие`, 409);
  }
}

/** На сверку ставится кончившийся месяц: текущий ещё идёт, и сверять в нём нечего. */
export class LedgerPeriodNotEndedError extends DomainError {
  constructor(period: string) {
    super("ledger_period_not_ended", `Месяц ${period} ещё не кончился: на сверку ставится прошлый месяц или более ранний`, 409);
  }
}

const STATUS_NAME: Readonly<Record<PeriodStatus, string>> = { open: "открыт", review: "на сверке", closed: "закрыт" };

/** Действие не подходит месяцу в его состоянии: закрывают только месяц на сверке, снимают закрытие — только закрытый. */
export class LedgerPeriodStatusError extends DomainError {
  constructor(period: string, status: PeriodStatus, expected: PeriodStatus) {
    super("ledger_period_status", `Месяц ${period} ${STATUS_NAME[status]}: это действие возможно, только когда месяц ${STATUS_NAME[expected]}`, 409);
  }
}

/** Закрытию мешают блокеры чек-листа: текст называет их, а подробности — в отчёте месяца. */
export class LedgerPeriodBlockedError extends DomainError {
  constructor(
    period: string,
    readonly blockers: readonly ChecklistItem[],
  ) {
    super("ledger_period_blocked", `Месяц ${period} нельзя закрыть: ${blockers.map((item) => item.message).join("; ")}`, 409);
  }
}

/** Пока считалось закрытие, журнал месяца или состояние месяца поменялись: считать заново, а не писать по устаревшему. */
export class LedgerPeriodChangedError extends DomainError {
  constructor(period: string) {
    super("ledger_period_changed", `Пока шло закрытие, в месяце ${period} появились новые проводки: повторите закрытие`, 409);
  }
}

/** По месяцу уже платили: закрытие не снять, поправка — в открытом месяце. */
export class LedgerPeriodHasPayoutsError extends DomainError {
  constructor(period: string) {
    super("ledger_period_has_payouts", `По месяцу ${period} уже есть выплаты: закрытие не снять, поправка вносится в открытом месяце`, 409);
  }
}
