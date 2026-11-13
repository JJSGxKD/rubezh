import { DomainError } from "../../common/domain-error.js";
import { formatBp, monthLabel } from "./stakeholder-rules.js";

/** Доли участников проекта (Р217, tasks/T-0452): отказы, которые панель показывает владельцу как есть. */

/** Месяц начала раньше текущего: прошлые месяцы не пересчитываются, пока нет закрытых периодов — и после. */
export class StakeholderMonthPastError extends DomainError {
  constructor() {
    super("stakeholder_month_past", "Долю можно поменять только с текущего месяца или позже: прошлые месяцы не пересчитываются", 400);
  }
}

/** Доля больше нуля — только аккаунту с ролью участника; ноль (конец участия) можно поставить любому. */
export class StakeholderRoleRequiredError extends DomainError {
  constructor() {
    super("stakeholder_role_required", "У аккаунта нет роли «Участник проекта» — долю больше нуля назначить нельзя", 409);
  }
}

/** Сумма долей на месяце вышла бы за 100 %. */
export class StakeholderSharesOverError extends DomainError {
  constructor(month: string, totalBp: number) {
    super("stakeholder_shares_over", `С ${monthLabel(month)} доли участников в сумме дали бы ${formatBp(totalBp)} % — больше 100 %`, 409);
  }
}

export class StakeholderAccountNotFoundError extends DomainError {
  constructor() {
    super("stakeholder_account_not_found", "Аккаунта нет", 404);
  }
}
