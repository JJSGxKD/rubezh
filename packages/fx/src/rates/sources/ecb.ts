import { Decimal } from "../../decimal.js";
import { assertHttpOk, SourceError, wantedIds, type SourceDefinition, type SourceQuote } from "../source.js";

/**
 * ЕЦБ — справочные курсы к евро, без ключа, раз в сутки около 16:00 CET.
 * Рубля у ЕЦБ нет с марта 2022 года, поэтому источник умеет только евро:
 * курс евро в долларах — это строка `USD` из его XML. Идентификатор у ЕЦБ —
 * трёхбуквенный код в атрибуте `currency`.
 *
 * Формат — по документации ЕЦБ; живой ответ сверяется при подключении (Р35).
 */
const DAY_MS = 24 * 3_600_000;

function parseCubes(xml: string): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  for (const match of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g)) {
    result.set(match[1]!, Decimal.of(match[2]!));
  }
  return result;
}

export const ecbSource: SourceDefinition = {
  id: "ecb",
  currencies: { EUR: "USD" },
  naturalIntervalMs: DAY_MS,
  quotedIn: "USD",
  free: { name: "free", baseUrl: "https://www.ecb.europa.eu", limits: { requestsPerMinute: null, requestsPerMonth: null } },
  async fetch(ctx) {
    const response = await ctx.http.get({ url: `${ctx.plan.baseUrl}/stats/eurofxref/eurofxref-daily.xml`, timeoutMs: ctx.timeoutMs });
    assertHttpOk(this.id, response.status);

    const cubes = parseCubes(response.body);
    const quotes: SourceQuote[] = [];
    for (const [code, id] of wantedIds(this, ctx.currencies)) {
      const usdPerEur = cubes.get(id);
      if (!usdPerEur) throw new SourceError(this.id, "missing", `в ответе нет строки ${id} для ${code}`);
      quotes.push({ currency: code, sourceCurrencyId: id, price: usdPerEur, quotedIn: "USD", observedAt: ctx.now });
    }
    return quotes;
  },
};
