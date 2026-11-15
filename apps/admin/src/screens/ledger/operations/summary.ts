import { formatAmount } from "../../../api/ledger";
import type { OperationView } from "../../../api/ledger-operations";
import { CURRENCY_DECIMALS, fromMinor, toMinor } from "./money";
import type { ChartPlace } from "./preview";

/** «1500» + `RUB` → «1 500,00 ₽»; дробь лишних знаков криптовалюты обрезана до двух: «130,50», а не «130,500000000». */
export function moneyText(raw: string | undefined, currency: string | undefined): string {
  if (raw === undefined || raw === "") return "—";
  if (currency === undefined) return raw;
  const minor = toMinor(raw, currency);
  if (minor === null) return `${raw} ${currency}`;
  const decimals = CURRENCY_DECIMALS[currency] ?? 0;
  let text = fromMinor(minor, currency);
  if (decimals > 2) text = text.replace(new RegExp(`(\\.\\d{2}\\d*?)0+$`, "u"), "$1");
  return formatAmount(text, currency);
}

function currencyOf(places: readonly ChartPlace[], accountId: string | undefined): string | undefined {
  return places.find((item) => item.accountId === accountId)?.currency;
}

/** Сумма операции одной строкой для списка: у обмена — «отдано → получено», у исправления — ключ исправляемой проводки. */
export function amountText(operation: OperationView, places: readonly ChartPlace[]): string {
  const { input } = operation;
  switch (input.kind) {
    case "exchange":
      return `${moneyText(input.given, currencyOf(places, input.from))} → ${moneyText(input.received, currencyOf(places, input.to))}`;
    case "transfer":
    case "expense":
      return moneyText(input.amount, currencyOf(places, input.from));
    case "income":
    case "loan":
      return moneyText(input.amount, currencyOf(places, input.to));
    case "reversal":
      return `сторно ${input.sourceKey ?? ""}`.trim();
  }
}

/** «2026-11-10» → «10.11.2026». */
export function dayText(at: string): string {
  const [year, month, day] = at.slice(0, 10).split("-");
  return year === undefined || month === undefined || day === undefined ? at : `${day}.${month}.${year}`;
}
