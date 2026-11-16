import type { OperationInput } from "../operations/operation-input.js";

/**
 * Колонки выплаты в `ledger_operation` (`payee`, `payout_period`, `override_reason`; docs/37-accounting.md §13,
 * tasks/T-0469): по ним находятся выплаты месяца и получателя без разбора JSON ввода. У остальных видов — пусто.
 */
export interface PayoutColumns {
  payee: string;
  period: string;
  overrideReason: string | null;
}

export function payoutColumnsOf(input: OperationInput): PayoutColumns | undefined {
  return input.kind === "payout" ? { payee: input.payee, period: input.period, overrideReason: input.overrideReason ?? null } : undefined;
}
