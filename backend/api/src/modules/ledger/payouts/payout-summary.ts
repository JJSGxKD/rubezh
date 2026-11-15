import { parsePayee } from "./payee.js";

/** Кому платят — словами для карточки операции: человек читает суть, а не строки проводки. */
function payeeWords(payee: string): string {
  switch (parsePayee(payee)?.kind) {
    case "stakeholder":
      return "участнику проекта";
    case "owner":
      return "владельцу";
    case "tax":
      return "на налог";
    case "loan":
      return "в погашение займа";
    case undefined:
      return "получателю";
  }
}

/** Выплата одной строкой для карточки «на подтверждении»: сумма, кому, за какой месяц и решение владельца, если оно есть. */
export function payoutSummary(input: { amount: string; payee: string; period: string; overrideReason?: string | undefined }, currency: string): string {
  const decision = input.overrideReason === undefined ? "" : ` (по решению владельца: ${input.overrideReason})`;
  return `${input.amount} ${currency} → ${payeeWords(input.payee)} за ${input.period}${decision}`;
}
