import { DomainError } from "../../common/domain-error.js";

/** Задания нет в каталоге — выключили в панели или id не тот. */
export class TaskNotFoundError extends DomainError {
  constructor() {
    super("task_not_found", "Такого задания нет", 404);
  }
}

/** Цель ещё не достигнута — забирать нечего. Клиент по коду перечитывает задания. */
export class TaskNotDoneError extends DomainError {
  constructor() {
    super("task_not_done", "Задание ещё не выполнено", 409);
  }
}

/** Срок и вид задания после создания не меняются: прогресс игроков записан по ним. */
export class TaskShapeLockedError extends DomainError {
  constructor() {
    super("task_shape_locked", "Срок и вид задания не меняются — заведите новое задание и выключите это", 409);
  }
}
