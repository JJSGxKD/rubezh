---
id: T-0348
title: Курсы фиата — ForexRateAPI ещё одним голосом рубля и евро, включается ключом из панели
epic: E13
priority: P2
status: done
owner: claude-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/fx/src/sources/fiat.ts
  - packages/fx/src/index.ts
  - packages/fx/test/sources.test.ts
  - packages/fx/test/fixtures/forexrateapi-latest.json
  - backend/api/src/modules/fx/fx.refresher.ts
  - backend/api/src/modules/secrets/secret-catalog.ts
  - backend/api/src/infra/outbound/outbound-services.ts
  - backend/api/test/fx.test.ts
  - backend/api/test/secrets.test.ts
shared:
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
  - backend/api/test/outbound.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 4
---

# T-0348. Курсы фиата — ForexRateAPI ещё одним голосом рубля и евро, включается ключом из панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0348.json)](README.md#значки-статуса)

## Зачем

Рубль и евро к доллару сейчас дают три источника: ЦБ, ЕЦБ и ExchangeRate-API
(`docs/35-stage4-plan.md`, §3.12, таблица «Как сделано — часть 2а»). Когда ЦБ
или ЕЦБ молчит (праздники, сбой), у рубля или евро остаётся один голос
медианы. Владелец решил добавить ForexRateAPI ещё одним голосом (Р175).

## Решения

Решение владельца **Р175** (`docs/35-stage4-plan.md`, 28.10.2026):

- **Голос медианы** по рублю и евро наравне с ExchangeRate-API, а не запасной
  на случай молчания остальных.
- **Включается ключом** из панели — ключ `fx.forexrateapi` в каталоге ключей
  интеграций (Р53, Р84). Без ключа источника в проходе нет (как CoinMarketCap).
- **Ключ — заголовком `X-API-KEY`**, не параметром адреса: в адрес и журнал
  исходящих он не попадает.
- **Тариф по умолчанию — Free:** 100 запросов в месяц, опрос раз в 12 часов
  (около 60 в месяц). Лимит правится в панели (Р89). Платный тариф —
  сменой ключа и лимита, без релиза.

Факты API (документация forexrateapi.com, сверено 28.10.2026):

- `GET https://api.forexrateapi.com/v1/latest?base=USD&currencies=RUB,EUR`,
  заголовок `X-API-KEY: <ключ>`;
- ответ: `{ "success": true, "base": "USD", "timestamp": 1672259320,
  "rates": { "EUR": 0.94215187, "RUB": 81.2 } }` — `timestamp` — секунды UNIX
  момента сбора курсов, `rates` — сколько единиц за доллар;
- ошибка: `{ "success": false, "error": { "code": 104, "info": "…" } }`
  (104 — слишком часто, 105 — исчерпан месячный лимит);
- `GET https://api.forexrateapi.com/v1/usage` с тем же заголовком — тариф и
  расход, **квоту не тратит**: им проверяется ключ из панели;
- формат ключа в документации не описан.

## Как сейчас

- `packages/fx/src/sources/fiat.ts:117–153` — `ERAPI_CURRENCIES`, схема
  `erapiSchema`, `createErApiSource`, `parseErApi`: образец, по которому
  делается новый источник. Тарифы — `ERAPI_TARIFFS` (строки 30–33), тип
  `Tariff` — `packages/fx/src/budget.ts`.
- `packages/fx/src/sources/http.ts:35` — `fetchJson(fetch, source, url, signal,
  schema, headers)`: заголовки уже поддерживаются; `429` → `SourceRateLimitedError`.
- `packages/fx/src/index.ts:41` — экспорт источников фиата.
- `backend/api/src/modules/fx/fx.refresher.ts:67–82` — `fxSources`: список
  источников прохода, ключи читаются на каждом проходе; CoinMarketCap
  включается только с ключом (строка 79) — тот же приём.
- `backend/api/src/modules/secrets/secret-catalog.ts:110, 186–205` — сервис и
  запись `erapi` в `SECRETS`, проверка ключа — `keyCheck`.
- `backend/api/src/infra/outbound/outbound-services.ts:13–20` —
  `OUTBOUND_SERVICES`, имена исходящих сервисов (`fx.erapi`, …); сторож —
  `backend/api/test/outbound-sites.test.ts`.
- Тесты: `packages/fx/test/sources.test.ts:84–91, 210–245` (erapi, фикстуры в
  `packages/fx/test/fixtures/`), `backend/api/test/fx.test.ts:131–158`
  (`fxSources`, список id), `backend/api/test/secrets.test.ts:321–345`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красные.
2. **Фикстура** `packages/fx/test/fixtures/forexrateapi-latest.json` — ответ
   по документации (не снят с сервиса — так и написать в комментарии теста,
   как у `erapi-v6-latest.json`).
3. **`fiat.ts`**:
   - `FOREXRATEAPI_CURRENCIES` — рубль и евро с буквенными кодами, как у erapi;
   - `FOREXRATEAPI_TARIFF: Tariff = { name: "free", perMinute: 1, perMonth: 100, minIntervalMs: 12 * HOUR }`;
   - схема ответа: `success: z.literal(true)`, `base: z.literal("USD")`,
     `timestamp` — целое положительное, `rates` — запись «код → положительное
     число»; ответ с `success: false` не проходит схему → источник недоступен;
   - `createForexRateApiSource({ fetch, key })`: `id: "forexrateapi"`, адрес из
     «Решений», ключ — заголовком `X-API-KEY`; пустой ключ — `RangeError`
     «ключ ForexRateAPI пуст»;
   - `parseForexRateApi(body)` — котировки `quoteFromUnitsPerUsd` с моментом
     `timestamp`, как `parseErApi`;
   - комментарий в шапке файла — строка про ForexRateAPI рядом с
     ExchangeRate-API: голос медианы, только с ключом, Free — 100 запросов,
     условия Free — некоммерческие (Р175).
4. **`index.ts`** — экспорт `FOREXRATEAPI_CURRENCIES`, `FOREXRATEAPI_TARIFF`,
   `createForexRateApiSource`, `parseForexRateApi`.
5. **`outbound-services.ts`** — `"fx.forexrateapi"` после `"fx.erapi"`.
6. **`secret-catalog.ts`** — запись `forexrateapi` после `erapi`:
   `key: "fx.forexrateapi"`, сервис «Курсы валют · ForexRateAPI», заголовок
   «Ключ ForexRateAPI», подсказка «Ещё один голос курсов рубля и евро. Без
   ключа источник выключен», `cabinetUrl: "https://forexrateapi.com/dashboard"`,
   `pattern: /^[A-Za-z0-9_-]{16,128}$/` (формат не описан — шаблон только
   отсекает мусор и знаки, которым не место в заголовке),
   `example: "0123456789abcdef0123456789abcdef"`, `fromEnv: () => null`,
   проверка `keyCheck` адресом `/v1/usage` с заголовком `X-API-KEY`.
7. **`fx.refresher.ts`** — в `fxSources` после erapi:
   `...(forexrateapi === null ? [] : [createForexRateApiSource({ fetch: fetchFor("fx.forexrateapi"), key: forexrateapi })])`;
   комментарий над функцией дополнить.
8. **Документы** (раздел «Документы»).

## Чего не трогаем

- Пороги согласия и свежести (`policy.ts`), медиану и приём курса.
- Остальные источники и их тарифы.
- Переменные окружения: ключ — только из панели.

## Тесты

- `packages/fx/test/sources.test.ts`:
  - разбор фикстуры: рубль и евро, момент — из `timestamp`;
  - ключ уходит заголовком `X-API-KEY`, в адресе ключа нет; адрес — с
    `base=USD` и `currencies=RUB,EUR`;
  - ответ `{ success: false, error: { code: 105, … } }` — источник недоступен
    (как erapi на `result: "error"`);
  - `429` — `SourceRateLimitedError`;
  - тариф — `FOREXRATEAPI_TARIFF`, 100 в месяц, раз в 12 часов;
  - пустой ключ — `RangeError`.
- `backend/api/test/fx.test.ts`: без ключа списка источников прежний
  (`["cbr", "ecb", "erapi", "coingecko", "tonapi", "binance"]`); с ключом
  `fx.forexrateapi` — `forexrateapi` сразу после `erapi`.
- `backend/api/test/secrets.test.ts`: ключ в каталоге, шаблон пропускает пример
  и отвергает пустой, короткий и с пробелом; проверка ключа идёт на `/v1/usage`
  с заголовком, ключа в адресе нет.

## Аналитика

Новых событий нет: опрос и сбои источника уже пишутся общими логами и
метриками прохода курсов с `source` в метке (низкая кардинальность — id
источника).

## Настройки и окружение

Новый ключ интеграции `fx.forexrateapi` (панель → «Ключи интеграций»). Новых
переменных окружения и ключей каталога настроек нет.

## Документы

- `docs/30-configuration-map.md`: в строку источников фиата (стр. ~224) —
  ForexRateAPI и `FOREXRATEAPI_TARIFF`; новая строка про ключ
  `fx.forexrateapi` рядом со строкой ключа ExchangeRate-API (стр. ~230).
- `docs/35-stage4-plan.md`, §3.12, таблица «Как сделано — часть 2а»: строка
  ForexRateAPI после ExchangeRate-API — «голос рубля и евро, только с ключом
  (Р175)», опрос раз в 12 часов, «Free — 100 запросов в месяц, условия
  некоммерческие».

## Критерии приёмки

- [x] Без ключа `fx.forexrateapi` проход курсов тот же, что был.
- [x] С ключом источник даёт голос рубля и евро, ключ — только в заголовке.
- [x] Ошибка API и `429` не роняют проход: источник просто молчит.
- [x] Ключ проверяется из панели запросом, который не тратит квоту.
- [x] Документы обновлены.

## PR

- **Заголовок:** `feat(fx): Курсы фиата — голос ForexRateAPI`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  💱 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЕЩЁ ОДИН ГОЛОС КУРСОВ РУБЛЯ И ЕВРО**

  ForexRateAPI стал ещё одним голосом медианы по рублю и евро (Р175). Включается ключом в панели → «Ключи интеграций» → «Ключ ForexRateAPI»; без ключа ничего не меняется. Лимит по умолчанию — тариф Free, 100 запросов в месяц, опрос раз в 12 часов.

  ❓ **Нужно от команды**

  • @владелец — завести ключ на forexrateapi.com и вставить его в панель; условия тарифа Free — некоммерческие, при переходе на платный поправить лимит там же
  ```
