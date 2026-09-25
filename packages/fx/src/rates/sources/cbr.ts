import { Decimal } from "../../decimal.js";
import { assertHttpOk, SourceError, wantedIds, type SourceDefinition, type SourceQuote } from "../source.js";
import { RATE_SCALE } from "../rate.js";

/**
 * ЦБ РФ — официальный курс, без ключа, меняется раз в сутки. Отдаёт XML в
 * windows-1251: имена валют в нём читаться не будут, но нам нужны только
 * `ID`, `Nominal` и `Value`, а они ASCII. Идентификатор валюты у ЦБ — код
 * `R01…`, а не буквенный: он и хранится в наблюдении.
 *
 * ЦБ котирует рубли за единицу валюты, поэтому курс рубля — обратный курсу
 * доллара, а курс евро — через доллар: `EUR/RUB ÷ USD/RUB`.
 *
 * Формат ответа — по документации ЦБ; из контейнера разработки сеть до
 * источника закрыта, живой ответ сверяется при подключении (Р35).
 */
const USD_ID = "R01235";
const DAY_MS = 24 * 3_600_000;

interface CbrValute {
  id: string;
  nominal: Decimal;
  value: Decimal;
}

function parseValutes(xml: string): Map<string, CbrValute> {
  const result = new Map<string, CbrValute>();
  const valute = /<Valute\s+ID="([^"]+)">([\s\S]*?)<\/Valute>/g;
  for (const match of xml.matchAll(valute)) {
    const [, id, body] = match;
    const nominal = /<Nominal>(\d+)<\/Nominal>/.exec(body!)?.[1];
    const value = /<Value>([\d,]+)<\/Value>/.exec(body!)?.[1];
    if (!nominal || !value) continue;
    // Десятичный разделитель у ЦБ — запятая.
    result.set(id!, { id: id!, nominal: Decimal.of(nominal), value: Decimal.of(value.replace(",", ".")) });
  }
  return result;
}

export const cbrSource: SourceDefinition = {
  id: "cbr",
  currencies: { RUB: USD_ID, EUR: "R01239" },
  naturalIntervalMs: DAY_MS,
  quotedIn: "USD",
  free: { name: "free", baseUrl: "https://www.cbr.ru", limits: { requestsPerMinute: null, requestsPerMonth: null } },
  async fetch(ctx) {
    const response = await ctx.http.get({ url: `${ctx.plan.baseUrl}/scripts/XML_daily.asp`, timeoutMs: ctx.timeoutMs });
    assertHttpOk(this.id, response.status);

    const valutes = parseValutes(response.body);
    const usd = valutes.get(USD_ID);
    if (!usd) throw new SourceError(this.id, "missing", `в ответе нет доллара (${USD_ID})`);
    const rubPerUsd = usd.value.div(usd.nominal, RATE_SCALE);

    const quotes: SourceQuote[] = [];
    for (const [code, id] of wantedIds(this, ctx.currencies)) {
      if (code === "RUB") {
        quotes.push({ currency: "RUB", sourceCurrencyId: id, price: Decimal.ONE.div(rubPerUsd, RATE_SCALE), quotedIn: "USD", observedAt: ctx.now });
        continue;
      }
      const valute = valutes.get(id);
      if (!valute) throw new SourceError(this.id, "missing", `в ответе нет валюты ${code} (${id})`);
      const rubPerUnit = valute.value.div(valute.nominal, RATE_SCALE);
      quotes.push({ currency: code, sourceCurrencyId: id, price: rubPerUnit.div(rubPerUsd, RATE_SCALE), quotedIn: "USD", observedAt: ctx.now });
    }
    return quotes;
  },
};
