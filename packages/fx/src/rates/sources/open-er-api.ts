import { z } from "zod";
import { Decimal } from "../../decimal.js";
import { assertHttpOk, SourceError, wantedIds, type SourceDefinition, type SourceQuote } from "../source.js";
import { RATE_SCALE } from "../rate.js";

/**
 * Запасной бесплатный форекс-API (open.er-api.com): курсы к доллару, без
 * ключа, обновление раз в сутки. Нужен на случай, когда ЦБ или ЕЦБ молчат.
 * Котирует «единиц валюты за доллар», поэтому наш курс — обратный.
 *
 * Лимит бесплатного тарифа — рабочее значение по документации источника,
 * сверяется при подключении (Р35).
 */
const DAY_MS = 24 * 3_600_000;

const responseSchema = z.object({
  result: z.string(),
  rates: z.record(z.string(), z.number()),
});

export const openErApiSource: SourceDefinition = {
  id: "open-er-api",
  currencies: { RUB: "RUB", EUR: "EUR" },
  naturalIntervalMs: DAY_MS,
  quotedIn: "USD",
  free: { name: "free", baseUrl: "https://open.er-api.com", limits: { requestsPerMinute: null, requestsPerMonth: 1500 } },
  async fetch(ctx) {
    const response = await ctx.http.get({ url: `${ctx.plan.baseUrl}/v6/latest/USD`, timeoutMs: ctx.timeoutMs });
    assertHttpOk(this.id, response.status);

    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(response.body));
    } catch (error) {
      throw new SourceError(this.id, "parse", `ответ не разобран: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.result !== "success") throw new SourceError(this.id, "http", `источник ответил ${parsed.result}`);

    const quotes: SourceQuote[] = [];
    for (const [code, id] of wantedIds(this, ctx.currencies)) {
      const unitsPerUsd = parsed.rates[id];
      if (unitsPerUsd === undefined || unitsPerUsd <= 0) throw new SourceError(this.id, "missing", `в ответе нет валюты ${code} (${id})`);
      quotes.push({ currency: code, sourceCurrencyId: id, price: Decimal.ONE.div(Decimal.of(unitsPerUsd), RATE_SCALE), quotedIn: "USD", observedAt: ctx.now });
    }
    return quotes;
  },
};
