/**
 * Ядро учёта (docs/37-accounting.md, Р98, Р219): двойная запись в целых
 * минимальных единицах валюты, проверка баланса, сторно, остатки. Ни игры, ни
 * Nest, ни Prisma, ни справочника валют — его передаёт вызывающий; журнал в
 * базе строит бэкенд поверх этого пакета.
 */
export { normalSign, type AccountType, type LedgerAccount } from "./accounts.js";
export { balances, trialBalance } from "./balances.js";
export {
  MAX_SOURCE_KEY_LENGTH,
  findEntryProblems,
  periodOf,
  periodOfEntry,
  reverse,
  type EntryDraft,
  type EntryLine,
  type EntryProblem,
} from "./entries.js";
export { formatMinor, toMinor, type CurrencySpec } from "./money.js";
export {
  BASIS_POINTS,
  computeWaterfall,
  type WaterfallInput,
  type WaterfallLine,
  type WaterfallLoan,
  type WaterfallPayout,
  type WaterfallResult,
  type WaterfallShare,
  type WaterfallTranche,
} from "./waterfall.js";
