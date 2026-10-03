import { DomainError } from "../../common/domain-error.js";

/** Файл не прошёл проверку профиля: не WebP, велик, не квадрат и так далее — причина словами. */
export class ImageRejectedError extends DomainError {
  constructor(problem: string) {
    super("image_rejected", problem, 400);
  }
}

/** Картинки с таким id нет — не загружали или адрес набран руками. */
export class ImageNotFoundError extends DomainError {
  constructor() {
    super("image_not_found", "Картинка не найдена — загрузите её заново", 404);
  }
}
