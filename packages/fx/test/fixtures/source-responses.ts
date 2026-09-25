// Ответы источников — по их документации: из контейнера разработки сеть до
// источников закрыта, живые ответы сверяются при подключении (Р35). Формы
// ответов здесь — то, что адаптеры обязаны разбирать; поменялся формат у
// источника — меняется и заготовка, и адаптер.

export const CBR_XML = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="25.09.2026" name="Foreign Currency Market">
<Valute ID="R01010"><NumCode>036</NumCode><CharCode>AUD</CharCode><Nominal>1</Nominal><Name>Австралийский доллар</Name><Value>60,1234</Value><VunitRate>60,1234</VunitRate></Valute>
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>92,5000</Value><VunitRate>92,5</VunitRate></Valute>
<Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>99,9000</Value><VunitRate>99,9</VunitRate></Valute>
<Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>Японских иен</Name><Value>61,5000</Value><VunitRate>0,615</VunitRate></Valute>
</ValCurs>`;

export const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject>
<Cube><Cube time='2026-09-25'>
<Cube currency='USD' rate='1.0812'/>
<Cube currency='JPY' rate='161.35'/>
<Cube currency='GBP' rate='0.8391'/>
</Cube></Cube>
</gesmes:Envelope>`;

export const OPEN_ER_API_JSON = JSON.stringify({
  result: "success",
  provider: "https://www.exchangerate-api.com",
  base_code: "USD",
  time_last_update_unix: 1_790_000_000,
  rates: { USD: 1, EUR: 0.925, RUB: 92.5, JPY: 149.2 },
});

/** Ответ агрегатора с посторонней монетой, у которой `id` совпадает с тикером Gram: адаптер обязан взять `the-open-network`. */
export const COINGECKO_JSON = JSON.stringify({
  "the-open-network": { usd: 3.21 },
  tether: { usd: 0.9998 },
  gram: { usd: 0.0001 },
});

export const BINANCE_JSON = JSON.stringify([
  { symbol: "TONUSDT", price: "3.19500000" },
  { symbol: "GRAMUSDT", price: "0.00010000" },
]);

/** У TON API монета сети приходит заглавными, жетоны — по адресу; посторонний жетон с тикером GRAM — отдельной записью. */
export const TONAPI_JSON = JSON.stringify({
  rates: {
    TON: { prices: { USD: 3.2 }, diff_24h: { USD: "+1.2%" } },
    "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs": { prices: { USD: 0.9997 } },
    "EQ_impostor_jetton_with_ticker_GRAM": { prices: { USD: 0.0001 } },
  },
});
