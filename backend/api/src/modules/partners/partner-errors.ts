import { DomainError } from "../../common/domain-error.js";

/** TG id партнёра уникален: второй партнёр с тем же id получает отказ с именем первого. */
export class PartnerTelegramTakenError extends DomainError {
  constructor(holderName: string) {
    super("partner_telegram_taken", `Этот TG id уже у партнёра «${holderName}»`, 409);
  }
}
