import { isCurrencyCode } from "@bh/fx";
import { MAX_SOURCE_KEY_LENGTH, formatMinor, type EntryProblem } from "@bh/ledger";
import { currencySpec } from "./ledger-currencies.js";

/** Сумма в виде для сообщения: со знаками валюты, а если валюты нет в справочнике — как есть, чтобы текст не упал. */
function sumText(sum: bigint, currency: string): string {
  return isCurrencyCode(currency) ? formatMinor(sum, currencySpec(currency)) : sum.toString();
}

/** Проблема проводки по-русски, для человека, который пишет проводку или разбирает отказ источника. */
export function describeProblem(problem: EntryProblem): string {
  switch (problem.kind) {
    case "empty_source_key":
      return "Не задан ключ источника проводки";
    case "source_key_too_long":
      return `Ключ источника длиннее ${String(MAX_SOURCE_KEY_LENGTH)} знаков`;
    case "too_few_lines":
      return "В проводке меньше двух строк";
    case "zero_line":
      return `Строка по счёту «${problem.accountId}» с нулевой суммой`;
    case "unknown_account":
      return `Счёта «${problem.accountId}» нет в плане счетов`;
    case "duplicate_account":
      return `Счёт «${problem.accountId}» встречается в проводке больше одного раза`;
    case "unbalanced":
      return `Проводка не сходится в валюте ${problem.currency}: сумма строк ${sumText(problem.sum, problem.currency)} вместо нуля`;
  }
}
