import { DomainError } from "../../common/domain-error.js";

/**
 * Игрока нет, он заблокирован или правило доски не показывает его смотрящему — для карточки это
 * одно и то же: ответ не должен выдавать, который из случаев произошёл (tasks/T-0247).
 */
export class PlayerNotFoundError extends DomainError {
  constructor() {
    super("player_not_found", "Игрок не найден", 404);
  }
}
