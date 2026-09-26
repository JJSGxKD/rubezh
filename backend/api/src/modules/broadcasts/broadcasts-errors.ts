import { DomainError } from "../../common/domain-error.js";

export class BroadcastNotFoundError extends DomainError {
  constructor() {
    super("broadcast_not_found", "Рассылки нет", 404);
  }
}

/** Действие не подходит состоянию: правка запущенной, второй старт, продолжение неначатой. */
export class BroadcastStateError extends DomainError {
  constructor(message: string) {
    super("broadcast_state", message, 409);
  }
}

/** Правило двух ключей (docs/29-admin-panel.md §8): большую аудиторию одобряет второй человек. */
export class BroadcastApprovalRequiredError extends DomainError {
  constructor(threshold: number) {
    super("approval_required", `Аудитория больше ${threshold} — нужно одобрение второго человека с правом одобрять рассылки`, 403);
  }
}
