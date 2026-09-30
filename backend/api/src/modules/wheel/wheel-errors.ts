import { DomainError } from "../../common/domain-error.js";

/**
 * Бесплатная крутка этих суток уже была — вторая с другой вкладки или с
 * устаревшего экрана. Клиент по коду перечитывает колесо и показывает отсчёт.
 */
export class WheelSpentError extends DomainError {
  constructor() {
    super("wheel_spent", "Бесплатная крутка на сегодня уже была", 409);
  }
}
