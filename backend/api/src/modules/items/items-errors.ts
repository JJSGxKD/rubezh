import { DomainError } from "../../common/domain-error.js";

/** Предмета нет у этого аккаунта — или он уже разобран: чужой и несуществующий неотличимы. */
export class ItemNotFoundError extends DomainError {
  constructor() {
    super("item_not_found", "Предмет не найден", 404);
  }
}

/**
 * Операция нарушает правило снаряжения: уровень в потолке, объединяются
 * разные редкости, инвентарь полон. `code` — для клиента, текст — для игрока.
 */
export class ItemRuleError extends DomainError {
  constructor(code: ItemRuleCode, message: string) {
    super(code, message, 409);
  }
}

export type ItemRuleCode = "item_max_level" | "item_no_extra" | "merge_mismatch" | "merge_max_rarity" | "inventory_full";
