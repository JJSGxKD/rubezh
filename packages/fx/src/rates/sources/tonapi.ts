import { z } from "zod";
import { Decimal } from "../../decimal.js";
import { assertHttpOk, SourceError, wantedIds, type SourceDefinition, type SourceQuote } from "../source.js";

/**
 * TON API — курсы монеты сети и жетонов в долларах. Монета — по имени `ton`,
 * жетон USDT — по адресу контракта: именно адрес отличает настоящий USDT в
 * сети TON от любого жетона с тем же тикером. Без ключа — с ограничением
 * частоты; ключ (`Authorization: Bearer`) поднимает лимит. Значения лимитов —
 * рабочие, по документации, сверяются при подключении (Р35).
 */
const MINUTE_MS = 60_000;

const USDT_JETTON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

const responseSchema = z.object({
  rates: z.record(z.string(), z.object({ prices: z.record(z.string(), z.number().positive()) })),
});

export const tonapiSource: SourceDefinition = {
  id: "tonapi",
  currencies: { GRAM: "ton", USDT: USDT_JETTON },
  naturalIntervalMs: MINUTE_MS,
  quotedIn: "USD",
  free: { name: "free", baseUrl: "https://tonapi.io", limits: { requestsPerMinute: 60, requestsPerMonth: null } },
  paid: { name: "paid", baseUrl: "https://tonapi.io", limits: { requestsPerMinute: 600, requestsPerMonth: null }, keyHeader: "Authorization" },
  async fetch(ctx) {
    const wanted = wantedIds(this, ctx.currencies);
    const tokens = wanted.map(([, id]) => id).join(",");
    const headers = ctx.plan.keyHeader && ctx.apiKey ? { [ctx.plan.keyHeader]: `Bearer ${ctx.apiKey}` } : undefined;
    const response = await ctx.http.get({ url: `${ctx.plan.baseUrl}/v2/rates?tokens=${encodeURIComponent(tokens)}&currencies=usd`, headers, timeoutMs: ctx.timeoutMs });
    assertHttpOk(this.id, response.status);

    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(response.body));
    } catch (error) {
      throw new SourceError(this.id, "parse", `ответ не разобран: ${error instanceof Error ? error.message : String(error)}`);
    }

    const quotes: SourceQuote[] = [];
    for (const [code, id] of wanted) {
      // Ключи в ответе — как в запросе, но монета сети приходит заглавными: `TON`.
      const entry = parsed.rates[id] ?? parsed.rates[id.toUpperCase()];
      const usd = entry?.prices["USD"] ?? entry?.prices["usd"];
      if (usd === undefined) throw new SourceError(this.id, "missing", `в ответе нет курса ${code} (${id})`);
      quotes.push({ currency: code, sourceCurrencyId: id, price: Decimal.of(usd), quotedIn: "USD", observedAt: ctx.now });
    }
    return quotes;
  },
};
