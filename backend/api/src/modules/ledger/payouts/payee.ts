/**
 * Кому платят (docs/37-accounting.md §13, Р222, tasks/T-0469): участнику проекта, владельцу, на налог или в погашение
 * транша займа. Получатель хранится строкой — она же лежит в `ledger_operation.payee`: `stakeholder:<аккаунт>`, `owner`,
 * `tax`, `loan:<заём>`. Чистые функции без Nest и Prisma.
 */

export type Payee = { kind: "stakeholder"; accountId: string } | { kind: "owner" } | { kind: "tax" } | { kind: "loan"; loanId: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Любой допустимый получатель одной строкой: схема тела проверяет ею, `parsePayee` разбирает. */
export const PAYEE_PATTERN = new RegExp(`^(?:owner|tax|stakeholder:${UUID}|loan:${UUID})$`, "u");

const STAKEHOLDER = new RegExp(`^stakeholder:(${UUID})$`, "u");
const LOAN = new RegExp(`^loan:(${UUID})$`, "u");

/** Строка получателя в вид; не получатель — `null`. */
export function parsePayee(raw: string): Payee | null {
  if (raw === "owner") return { kind: "owner" };
  if (raw === "tax") return { kind: "tax" };
  const stakeholder = STAKEHOLDER.exec(raw)?.[1];
  if (stakeholder !== undefined) return { kind: "stakeholder", accountId: stakeholder };
  const loan = LOAN.exec(raw)?.[1];
  if (loan !== undefined) return { kind: "loan", loanId: loan };
  return null;
}

export function payeeKey(payee: Payee): string {
  switch (payee.kind) {
    case "stakeholder":
      return `stakeholder:${payee.accountId}`;
    case "loan":
      return `loan:${payee.loanId}`;
    case "owner":
      return "owner";
    case "tax":
      return "tax";
  }
}

/** Счёт обязательства перед участником: его заводит закрытие месяца (`period-close.ts`). */
export function stakeholderDebtAccount(accountId: string): string {
  return `liability.stakeholder.${accountId}.RUB`;
}

/** Обязательство по налогу НПД: заводится закрытием месяца. */
export const TAX_DEBT_ACCOUNT = "liability.tax.RUB";

/** Счёт «Выплаты владельцу» в валюте места: заводится первой выплатой. */
export function ownerDrawAccount(currency: string): string {
  return `equity.owner_draw.${currency}`;
}
