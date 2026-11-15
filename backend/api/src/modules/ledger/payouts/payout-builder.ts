import { Assembly, type BuildResult } from "../operations/builder-kit.js";
import type { OperationInputOf } from "../operations/operation-input.js";
import { ownerDrawAccount, parsePayee } from "./payee.js";
import { payoutProblems, type PayoutFacts } from "./payout-rules.js";

/**
 * Сборщик проводки «выплата» (docs/37-accounting.md §13, Р222, tasks/T-0469): место −сумма, обязательство получателя
 * +сумма (у владельца — «Выплаты владельцу» в валюте места). Деньги переводит человек, учёт только записывает. Правила
 * «можно ли платить» — `payout-rules.ts`; данные месяца приходят аргументом, сборщик по-прежнему чистая функция.
 * Нет данных месяца — отказ, а не выплата вслепую.
 */
export function buildPayout(a: Assembly, input: OperationInputOf<"payout">, facts: PayoutFacts | undefined): BuildResult {
  const payee = parsePayee(input.payee);
  if (payee === null) a.problems.push({ message: `Выплата: получатель «${input.payee}» не из допустимых — участник проекта, владелец, налог или заём` });
  const from = a.place(input.from, "Откуда");
  if (facts === undefined) a.problems.push({ message: "Нет данных месяца для выплаты: месяц не прочитан" });
  if (payee === null || from === null || facts === undefined) return a.finish({ estimate: [] });

  const amount = a.amount(input.amount, from.currency, "Сумма");
  for (const message of payoutProblems({ payee, facts, place: from, amount, overrideReason: input.overrideReason })) a.problems.push({ message });
  const debtAccountId = payee.kind === "owner" ? ownerDrawAccount(from.currency) : facts.debtAccountId;
  if (debtAccountId === null) a.problems.push({ message: `У получателя «${facts.label}» нет счёта обязательства: платить нечего` });
  if (amount === null || debtAccountId === null || a.problems.length > 0) return a.finish({ estimate: [] });

  a.lines.add(from.accountId, -amount);
  a.lines.add(debtAccountId, amount);
  if (payee.kind === "owner") a.serviceAccounts.set(debtAccountId, { accountId: debtAccountId, type: "equity", currency: from.currency, name: `Выплаты владельцу, ${from.currency}` });
  a.meta.payee = input.payee;
  a.meta.payoutPeriod = input.period;
  if (input.overrideReason !== undefined) a.meta.overrideReason = input.overrideReason;
  return a.finish({ estimate: [{ currency: from.currency, minor: amount }] });
}
