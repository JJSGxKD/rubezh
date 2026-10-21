import { DomainError } from "../../common/domain-error.js";

/** TG id партнёра уникален: второй партнёр с тем же id получает отказ с именем первого. */
export class PartnerTelegramTakenError extends DomainError {
  constructor(holderName: string) {
    super("partner_telegram_taken", `Этот TG id уже у партнёра «${holderName}»`, 409);
  }
}

/** Партнёра с таким id нет: общая ошибка карточки партнёра и ссылок, которые заводят от его имени. */
export class PartnerNotFoundError extends DomainError {
  constructor() {
    super("partner_not_found", "Партнёра нет", 404);
  }
}
