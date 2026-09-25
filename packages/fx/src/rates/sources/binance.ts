import { z } from "zod";
import { Decimal } from "../../decimal.js";
import { assertHttpOk, SourceError, wantedIds, type SourceDefinition, type SourceQuote } from "../source.js";

/**
 * Binance — публичные котировки без ключа. Пара `TONUSDT` котирует Gram в
 * USDT, поэтому источник помечен `quotedIn: "USDT"`: сбор переводит цену в
 * доллары по курсу самого USDT. Идентификатор — символ пары.
 *
 * Лимит — рабочее значение по документации (вес запросов в минуту),
 * сверяется при подключении (Р35).
 */
const MINUTE_MS = 60_000;

const responseSchema = z.array(z.object({ symbol: z.string(), price: z.string() }));

export const binanceSource: SourceDefinition = {
  id: "binance",
  currencies: { GRAM: "TONUSDT" },
  naturalIntervalMs: MINUTE_MS,
  quotedIn: "USDT",
  free: { name: "free", baseUrl: "https://api.binance.com", limits: { requestsPerMinute: 600, requestsPerMonth: null } },
  async fetch(ctx) {
    const wanted = wantedIds(this, ctx.currencies);
    const symbols = encodeURIComponent(JSON.stringify(wanted.map(([, id]) => id)));
    const response = await ctx.http.get({ url: `${ctx.plan.baseUrl}/api/v3/ticker/price?symbols=${symbols}`, timeoutMs: ctx.timeoutMs });
    assertHttpOk(this.id, response.status);

    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(response.body));
    } catch (error) {
      throw new SourceError(this.id, "parse", `ответ не разобран: ${error instanceof Error ? error.message : String(error)}`);
    }

    const quotes: SourceQuote[] = [];
    for (const [code, id] of wanted) {
      const ticker = parsed.find((entry) => entry.symbol === id);
      if (!ticker) throw new SourceError(this.id, "missing", `в ответе нет пары ${code} (${id})`);
      const price = Decimal.parse(ticker.price);
      if (!price.isPositive()) throw new SourceError(this.id, "parse", `цена пары ${id} не положительна: ${ticker.price}`);
      quotes.push({ currency: code, sourceCurrencyId: id, price, quotedIn: "USDT", observedAt: ctx.now });
    }
    return quotes;
  },
};
