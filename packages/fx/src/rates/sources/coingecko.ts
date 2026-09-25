import { z } from "zod";
import { Decimal } from "../../decimal.js";
import { assertHttpOk, SourceError, wantedIds, type SourceDefinition, type SourceQuote } from "../source.js";

/**
 * CoinGecko — агрегатор с бесплатным лимитом. Валюта ищется по `id` монеты
 * (`the-open-network`, `tether`), а не по тикеру: посторонний жетон с
 * тикером GRAM в сети TON в ответ по `id` не попадает.
 *
 * Платный тариф — другой адрес и другой заголовок ключа; появление ключа в
 * окружении переключает тариф без правки кода. Лимиты — рабочие значения по
 * документации источника, сверяются при подключении (Р35).
 */
const MINUTE_MS = 60_000;

const responseSchema = z.record(z.string(), z.object({ usd: z.number().positive() }));

export const coingeckoSource: SourceDefinition = {
  id: "coingecko",
  currencies: { GRAM: "the-open-network", USDT: "tether" },
  naturalIntervalMs: MINUTE_MS,
  quotedIn: "USD",
  free: { name: "free", baseUrl: "https://api.coingecko.com/api/v3", limits: { requestsPerMinute: 5, requestsPerMonth: 10_000 } },
  paid: { name: "paid", baseUrl: "https://pro-api.coingecko.com/api/v3", limits: { requestsPerMinute: 500, requestsPerMonth: 500_000 }, keyHeader: "x-cg-pro-api-key" },
  async fetch(ctx) {
    const wanted = wantedIds(this, ctx.currencies);
    const ids = wanted.map(([, id]) => id).join(",");
    const headers = ctx.plan.keyHeader && ctx.apiKey ? { [ctx.plan.keyHeader]: ctx.apiKey } : undefined;
    const response = await ctx.http.get({ url: `${ctx.plan.baseUrl}/simple/price?ids=${ids}&vs_currencies=usd`, headers, timeoutMs: ctx.timeoutMs });
    assertHttpOk(this.id, response.status);

    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(response.body));
    } catch (error) {
      throw new SourceError(this.id, "parse", `ответ не разобран: ${error instanceof Error ? error.message : String(error)}`);
    }

    const quotes: SourceQuote[] = [];
    for (const [code, id] of wanted) {
      const entry = parsed[id];
      if (!entry) throw new SourceError(this.id, "missing", `в ответе нет монеты ${code} (${id})`);
      quotes.push({ currency: code, sourceCurrencyId: id, price: Decimal.of(entry.usd), quotedIn: "USD", observedAt: ctx.now });
    }
    return quotes;
  },
};
