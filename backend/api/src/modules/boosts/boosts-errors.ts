import { DomainError } from "../../common/domain-error.js";

/**
 * Забег уже начался: бусты — только до старта (Р17). Честный клиент сюда не
 * попадает — он покупает до «В бой», — а повтор покупки после старта ничего
 * не должен списать.
 */
export class BoostRunStartedError extends DomainError {
  constructor() {
    super("boost_run_started", "Забег уже начался — бусты покупаются до старта", 409);
  }
}
