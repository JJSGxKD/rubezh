---
id: T-0063
title: CoinMarketCap — новый источник курсов; необязательные ключи tonapi и erapi
epic: E13
priority: P2
status: done
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0062]
zones:
  - packages/fx/src/sources/crypto.ts
  - packages/fx/src/sources/fiat.ts
  - packages/fx/src/sources.ts
  - packages/fx/src/index.ts
  - packages/fx/test/sources.test.ts
  - packages/fx/test/fixtures/**
  - backend/api/src/modules/fx/fx.refresher.ts
  - backend/api/src/modules/secrets/secret-catalog.ts
  - backend/api/src/infra/outbound/outbound-services.ts
  - backend/api/test/secrets.test.ts
  - backend/api/test/fx.test.ts
shared:
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0063. CoinMarketCap — новый источник курсов; необязательные ключи tonapi и erapi

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0063.json)](README.md#значки-статуса) [![T-0062](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0062.json&label=T-0062)](T-0062-fx-source-limits-panel.md)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р89):

- **курс Gram и USDT — ещё и из CoinMarketCap.** Сейчас криптовалюты дают
  CoinGecko, tonapi и Binance; четвёртый источник — запас, если CoinGecko
  исчерпает лимит или ляжет;
- **у tonapi и erapi бывают ключи с лимитом выше.** Сейчас оба ходят на
  открытые адреса без ключа и работают; ключ нужен, только если открытого
  лимита перестанет хватать.

Binance ключа для котировок не требует — не трогаем.

## Решения

- **CoinMarketCap:**
  - источник `coinmarketcap`, работает только с ключом `fx.coinmarketcap` —
    без ключа его нет в списке источников;
  - валюты — Gram и USDT по числовым id CoinMarketCap, не по тикерам:
    тикер Toncoin менялся (`formerNames` у `GRAM`);
  - тариф «Basic» — 10 000 кредитов в месяц, 30 запросов в минуту; опрос
    не чаще раза в 5 минут. Один опрос обеих валют — один кредит.
- **tonapi** с ключом `fx.tonapi` — тот же адрес и заголовок
  `Authorization: Bearer <ключ>`, тариф с ключом. Без ключа — как сейчас.
- **erapi** с ключом `fx.erapi`:
  - адрес `https://v6.exchangerate-api.com/v6/<ключ>/latest/USD`;
  - тариф Free — 1 500 запросов в месяц;
  - без ключа — открытый `open.er-api.com`, как сейчас.
- **Проверка ключа** в «Ключах интеграций» — запросом, который не тратит
  кредиты, где он есть:
  - CoinMarketCap — `GET /v1/key/info`;
  - erapi — `GET /v6/<ключ>/quota`;
  - tonapi — запрос курса.
- **Лимиты** — из тарифов в коде; правятся в панели (T-0062).

## Как сейчас

- **`packages/fx/src/sources/crypto.ts`:**
  - CoinGecko — `COINGECKO_TARIFFS`, `COINGECKO_CURRENCIES`, схема ответа,
    `createCoinGeckoSource({ fetch, key })`;
  - tonapi — `createTonApiSource({ fetch })`, адрес
    `https://tonapi.io/v2/rates?tokens=ton&currencies=usd`;
  - Binance — `createBinanceSource`.
- **`packages/fx/src/sources/fiat.ts`** — `createErApiSource({ fetch })` на
  `https://open.er-api.com/v6/latest/USD`, `ERAPI_TARIFF`, `parseErApi`.
- **Общее для источников** — `packages/fx/src/sources/http.ts` (`fetchJson`)
  и `packages/fx/src/sources.ts` (`RateSource`, `Tariff`, `SourceCurrency`).
- **`backend/api/src/modules/fx/fx.refresher.ts`** — `fxSources(secrets, …)`
  собирает источники. Ключ CoinGecko — из `secrets` (`SECRETS.coingeckoPro`,
  `SECRETS.coingeckoDemo`).
- **`backend/api/src/modules/secrets/secret-catalog.ts`:**
  - записи `coingeckoPro`, `coingeckoDemo` — образец: `service: FX_SERVICE`,
    `pattern`, `example`, `cabinetUrl`, `check`;
  - `fromEnv` — для новых ключей `() => null`: они задаются только в
    панели.
- **`backend/api/src/infra/outbound/outbound-services.ts`** (T-0059) —
  каталог сервисов клиента исходящих.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), ответы — фикстурами в
   `packages/fx/test/fixtures/`.
2. **CoinMarketCap** в `crypto.ts`:

   ```ts
   export const COINMARKETCAP_TARIFF: Tariff; // { name: "basic", perMinute: 30, perMonth: 10_000, minIntervalMs: 5 * MINUTE }
   export const COINMARKETCAP_CURRENCIES: readonly SourceCurrency[]; // GRAM — "11419", USDT — "825"
   export function createCoinMarketCapSource(options: { fetch: FetchLike; key: string; now?: () => Date }): RateSource;
   export function parseCoinMarketCap(body: unknown, now: Date): Quote[];
   ```

   - запрос: `GET https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=11419,825&convert=USD`,
     заголовок `X-CMC_PRO_API_KEY`;
   - разбор по `data[id].quote.USD.price` и `last_updated`; схема Zod — только
     поля, которые читаются;
   - ответ 429 — `SourceRateLimitedError`, как у остальных источников (`fetchJson` в `sources/http.ts`).

   Id сверить с ответом `/v1/cryptocurrency/map` по документации
   CoinMarketCap. Не совпали — вопрос в PR, не подстановка.
3. **tonapi** — `createTonApiSource({ fetch, key? })`:
   - с ключом — заголовок и тариф `TONAPI_TARIFFS.keyed`: числа из
     документации tonapi на дату задачи, ссылкой в комментарии;
   - без ключа — как сейчас.
4. **erapi** — `createErApiSource({ fetch, key? })`:
   - с ключом — адрес `v6.exchangerate-api.com` и `ERAPI_TARIFFS.keyed`
     (1 500 в месяц);
   - без ключа — прежний.

   Разбор тот же: формат ответа совпадает, проверить фикстурой.
5. **Каталог ключей:**
   - `fx.coinmarketcap` — «Ключ CoinMarketCap», подсказка «Четвёртый
     источник курса Gram и USDT, тариф Basic — 10 000 кредитов в месяц. Без
     ключа источника нет»;
   - `fx.tonapi` — «Ключ tonapi», подсказка «Необязателен: без ключа курс
     Gram идёт открытым лимитом»;
   - `fx.erapi` — «Ключ ExchangeRate-API», подсказка «Необязателен: без
     ключа курсы рубля и евро идут открытым адресом».

   Вид ключа (`pattern`) и `example` — по документации сервиса; не нашёл
   формат — `^[A-Za-z0-9-]{16,64}$` и вопрос в PR.
6. **`fx.refresher.ts`** — `fxSources`: CoinMarketCap — если задан ключ;
   tonapi и erapi — с ключом, если он задан.
7. **Клиент исходящих** — сервис `fx.coinmarketcap` в `OUTBOUND_SERVICES`.
8. **Документы** — раздел «Документы».

## Чего не трогаем

- Лимиты в панели — T-0062 (тарифы отсюда они подхватят сами).
- Политику принятия курса (`accept.ts`): новый источник участвует в
  сверке как остальные.
- Binance.

## Тесты

Первым коммитом.

- **`packages/fx/test/sources.test.ts`:**
  - `parseCoinMarketCap` на фикстуре — котировки Gram и USDT в долларах,
    время из `last_updated`;
  - ответ без одной валюты — котировка только по второй;
  - 429 — `SourceRateLimitedError`;
  - запрос — с заголовком ключа и id в адресе;
  - tonapi и erapi:
    - с ключом — заголовок или адрес с ключом и тариф с ключом;
    - без ключа — прежние адрес и тариф.
- **`backend/api/test/secrets.test.ts`** — три новые записи каталога:
  - `fromEnv` — `null`;
  - проверка вида по `pattern`;
  - `check` на подменённом `fetch`: успех и отказ.
- **`backend/api/test/fx.test.ts`** — `fxSources`:
  - без ключа CoinMarketCap его нет;
  - с ключом — есть.

## Аналитика

Нет.

## Настройки и окружение

Три ключа каталога интеграций (Р84), только из панели. Переменных
окружения нет.

## Документы

- **`docs/30-configuration-map.md`** — три строки в таблице ключей
  интеграций.
- **`docs/35-stage4-plan.md`** — в списке источников курсов (§3.12)
  CoinMarketCap.

## Критерии приёмки

- [x] С ключом CoinMarketCap курс Gram и USDT приходит и от него, без
  ключа источника нет.
- [x] Ключи tonapi и erapi необязательны: без них — как сейчас, с ними —
  свой адрес и тариф.
- [x] Ключи проверяются кнопкой в «Ключах интеграций».
- [x] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(fx): Источник CoinMarketCap и ключи tonapi и erapi`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — COINMARKETCAP И КЛЮЧИ КУРСОВ**

  Курс Gram и USDT теперь может приходить и от CoinMarketCap — запас, если CoinGecko исчерпает лимит. Для tonapi и ExchangeRate-API можно задать ключи с лимитом выше; без них всё работает, как раньше.

  ❓ **Нужно от команды**

  • @участник1 — завести ключ CoinMarketCap (тариф Basic, бесплатный) и вписать его в «Ключи интеграций»
  ```
