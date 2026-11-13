export type AccountType = "asset" | "revenue" | "expense" | "liability" | "equity";

/** Счёт плана счетов: место хранения или статья в одной валюте (docs/37-accounting.md, §2–§3). */
export interface LedgerAccount {
  /** устойчивый ключ, «stars.bot.hold» */
  id: string;
  type: AccountType;
  /** код валюты из справочника вызывающего */
  currency: string;
  /** подпись для панели */
  name: string;
}

/**
 * Знак нормальной стороны. В строке проводки дебет — плюс, кредит — минус;
 * актив и расход растут по дебету, остальные — по кредиту. Остаток в отчёте
 * берётся со знаком нормальной стороны, и обычный счёт показывает положительное
 * число, а не «минус пятьдесят» у выручки.
 */
export function normalSign(type: AccountType): 1n | -1n {
  return type === "asset" || type === "expense" ? 1n : -1n;
}
