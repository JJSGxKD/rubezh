import { DomainError } from "../../common/domain-error.js";

/** У площадки игрока нет бота с проверкой имени и bio (MAX, VK, веб) — заданий там нет (Р110). */
export class BotMentionUnavailableForPlatformError extends DomainError {
  constructor() {
    super("bot_mention_unavailable", "Для этой площадки заданий с юзернеймом бота нет", 404);
  }
}

/** Функция выключена или за этот вид нет награды: игроку он не показывается, и проверять нечего. */
export class TaskNotOfferedError extends DomainError {
  constructor() {
    super("task_not_offered", "Такого задания нет", 404);
  }
}
