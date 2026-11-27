import { DomainError } from "../../common/domain-error.js";

/** Картинки с таким хэшем нет: не сохраняли, срок хранения вышел или адрес набран руками. */
export class CardNotFoundError extends DomainError {
  constructor() {
    super("card_not_found", "Картинка не найдена", 404);
  }
}
