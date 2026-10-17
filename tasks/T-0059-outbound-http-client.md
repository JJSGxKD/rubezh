---
id: T-0059
title: Один клиент исходящих запросов — все вызовы внешних API через него
epic: E13
priority: P1
status: done
owner: claude-5 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/infra/outbound/**
  - backend/api/src/modules/fx/fx.refresher.ts
  - backend/api/src/modules/fx/fx.module.ts
  - backend/api/src/modules/ads/taddy-api.ts
  - backend/api/src/modules/ads/taddy-exchange.ts
  - backend/api/src/modules/ads/ad-creatives.ts
  - backend/api/src/modules/ads/ads.module.ts
  - backend/api/src/modules/ad-conversions/conversions.service.ts
  - backend/api/src/modules/ad-conversions/ad-conversions.module.ts
  - backend/api/src/modules/admin/admin-secrets.service.ts
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/platforms/telegram/telegram.module.ts
  - backend/api/src/platforms/telegram/bot.module.ts
  - backend/api/test/outbound.test.ts
  - backend/api/test/outbound-sites.test.ts
  - backend/api/test/telegram-module.test.ts
shared:
  - backend/api/src/app.module.ts
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 2
---

# T-0059. Один клиент исходящих запросов — все вызовы внешних API через него

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0059.json)](README.md#значки-статуса)

## Зачем

Решения пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р91, Р92, WP47
часть 1):

- запросы к внешним API — через прокси, если напрямую не достучаться;
- каждый вызов — в журнал.

Для этого все вызовы должны идти через одно место. Сейчас каждый модуль
получает `fetch` параметром, и по умолчанию это глобальный `fetch`.

Задача — **рефакторинг без изменения поведения**:

- общий клиент с меткой сервиса;
- приёмник записей, пока пустой;
- все места вызова переведены на клиент.

Журнал — T-0060, прокси — T-0065.

## Решения

- **Клиент совместим с `fetch`.** `outbound.forService("fx.coingecko")`
  возвращает функцию с той же сигнатурой, что `typeof fetch`. Место вызова
  меняет только, откуда берёт `fetch`, — логика модулей и их тесты на
  подменах не меняются.
- **Сервис — строка из каталога** `OUTBOUND_SERVICES`. Метка — в журнале и в
  выборе прокси:

  | Сервис | Кто зовёт |
  |---|---|
  | `fx.cbr`, `fx.ecb`, `fx.erapi`, `fx.coingecko`, `fx.tonapi`, `fx.binance` | источники курсов (`fx.refresher.ts`, `fxSources`) |
  | `telegram.bot` | Bot API (`telegram-bot-api.ts`) |
  | `taddy.api`, `taddy.exchange` | `taddy-api.ts`, `taddy-exchange.ts` |
  | `ads.creatives` | креативы сетей (`ad-creatives.ts`) |
  | `ads.postback` | постбэки конверсий (`conversions.service.ts`) |
  | `secrets.check` | проверка ключа интеграции (`admin-secrets.service.ts`) |

- **Каждая попытка — запись в приёмник** `OutboundSink`. Запись:

  ```ts
  interface OutboundRecord {
    service: string; method: string;
    host: string;
    /** путь без query и без секретов: `/bot***/sendMessage`, `/v6/***/latest/USD` */
    path: string;
    status: number | null;
    ok: boolean;
    durationMs: number;
    /** `direct` или id прокси — после T-0065 */
    via: string;
    attempt: number;
    /** `timeout`, `network`, `aborted` или `null` */
    error: string | null;
    at: Date;
  }
  ```

  Приёмник по умолчанию — пустой (`NOOP_SINK`). Запись не должна ни
  задерживать, ни ронять вызов: ошибка приёмника глотается с `warn` в лог
  раз в минуту.
- **Секреты в адресе не уходят никуда.** Путь чистится до записи:
  - query отбрасывается целиком;
  - сегмент `bot<…>` у Bot API → `bot***`;
  - сегменты из `[A-Za-z0-9_-]` длиной 24 знака и больше → `***`.

Ответы claude-lead-1 на вопросы PR #374, 17.10.2026:
- `backend/api/test/telegram-module.test.ts` — в зонах. Это тест сборки
  модуля: он сверяет `inject` фабрики Bot API, а фабрика теперь получает
  `Outbound`. Тест повторяет шаг 3, поведение модуля он не проверяет, так что
  правило «прежние тесты модулей — без правок» на него не распространяется.
- Порог ключа — 24 знака и больше: ключ из примера в «Тестах»
  (`0123456789abcdef01234567`) ровно 24 знака, а прежняя формулировка
  «длиннее 24» его бы не скрыла.
- `ads.creatives` остаётся в каталоге без места вызова: креативы сетей
  `ad-creatives.ts` получает через клиентов сетей, своего `fetch` у него нет.
  Метка пригодится, когда загрузка креатива станет отдельным запросом.

## Как сейчас

Места вызова (все получают `fetch` параметром, по умолчанию — глобальный):

| Где | Что |
|---|---|
| `modules/fx/fx.refresher.ts:52` | `fxSources(secrets, fetchImpl = fetch)`, источники из `@bh/fx` с `{ fetch }` |
| `platforms/telegram/telegram-bot-api.ts:249` | `fetchImpl: FetchLike = fetch` |
| `modules/ads/taddy-api.ts:144`, `taddy-exchange.ts:149` | `fetchImpl: typeof fetch = fetch`, общий `postTaddy` |
| `modules/ads/ad-creatives.ts` | запрос креатива сети |
| `modules/ad-conversions/conversions.service.ts:70` | `tick(now, fetchImpl = fetch)` |
| `modules/admin/admin-secrets.service.ts:119` | `check(…, fetchImpl = fetch)` → `secret.check(value, fetchImpl)` |

Модули Nest собирают эти классы в своих `*.module.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Новый `backend/api/src/infra/outbound/`:**
   - `outbound-services.ts` — `OUTBOUND_SERVICES` (таблица «Решений») и
     `type OutboundService`;
   - `outbound-path.ts` — чистая `safePath(url: string): { host: string; path: string }`
     по правилу «Решений»;
   - `outbound.ts`:

     ```ts
     export interface OutboundSink { write(record: OutboundRecord): void }
     export const NOOP_SINK: OutboundSink;
     export const OUTBOUND_SINK = Symbol("OUTBOUND_SINK");
     @Injectable()
     export class Outbound {
       constructor(@Inject(OUTBOUND_SINK) sink: OutboundSink, now?: () => Date);
       /** fetch с меткой сервиса: вызов, время, исход — в приёмник. */
       forService(service: OutboundService): typeof fetch;
     }
     ```

     - внутри — глобальный `fetch`, отдельная запись на попытку;
     - **таймаут** — сигнал вызывающего, своего нет: он есть у каждого места
       вызова;
     - `AbortError` с причиной `TimeoutError` → `error: "timeout"`, прочий
       `AbortError` → `aborted`, `TypeError` сети → `network`;
     - ответ отдаётся вызывающему как есть, исключение — пробрасывается;
   - `outbound.module.ts` — `@Global()`, провайдеры `Outbound` и
     `OUTBOUND_SINK` → `NOOP_SINK`; строка в `app.module.ts`.
3. **Перевести места вызова** — модуль Nest передаёт
   `outbound.forService("<сервис>")` туда, где сейчас подставляется
   глобальный `fetch`:
   - `fxSources(secrets, fetchFor)` принимает `(service) => typeof fetch` и
     даёт каждому источнику свой;
   - умолчание `= fetch` в сигнатурах остаётся только для тестов. Новый код
     в модулях берёт клиент из DI.
4. **Тест мест вызова** (`outbound-sites.test.ts`): ни один файл
   `backend/api/src/**`, кроме `infra/outbound/`, не вызывает глобальный
   `fetch(`, а умолчания `= fetch` — только в известных параметрах.
   Новое место вызова мимо клиента — красный тест с именем файла.
5. **Документы** — раздел «Документы».

## Чего не трогаем

- Логику модулей, их таймауты, повторы и тесты на подменах.
- `@bh/fx` (`packages/fx`) — ядро получает `fetch` параметром, как сейчас.
- Клиент игры и панели: там исходящих к чужим API нет.

## Тесты

Первым коммитом.

- **`backend/api/test/outbound.test.ts`:**
  - `safePath`:
    - `https://api.telegram.org/bot123:ABC/sendMessage?chat_id=1` →
      `{ host: "api.telegram.org", path: "/bot***/sendMessage" }`;
    - `https://v6.exchangerate-api.com/v6/0123456789abcdef01234567/latest/USD` →
      ключ скрыт;
    - query отброшен всегда;
  - `forService` на подменённом глобальном `fetch`:
    - 200 → запись `ok: true`, статус, `durationMs ≥ 0`, `via: "direct"`,
      `attempt: 1`;
    - 500 → `ok: false`, статус 500, ответ отдан вызывающему;
    - таймаут → `error: "timeout"`, исключение проброшено;
    - сеть → `error: "network"`;
    - приёмник бросает → вызов всё равно отвечает.
- **`backend/api/test/outbound-sites.test.ts`** — правило шага 4.
- **Прежние тесты модулей** — без правок и зелёные.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- **`docs/21-diagrams.md`** — схема модулей бэкенда: `infra/outbound`, через
  который ходят курсы, Bot API, Taddy, креативы, постбэки и проверка ключей.

## Критерии приёмки

- [ ] Все вызовы внешних API идут через `Outbound.forService` с меткой
  сервиса. Тест мест вызова это держит.
- [ ] Поведение модулей не изменилось: прежние тесты зелёные без правок.
- [ ] Секреты из адреса не попадают в запись.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(api): Один клиент исходящих запросов`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОДИН КЛИЕНТ ИСХОДЯЩИХ ЗАПРОСОВ**

  Все обращения сервера к внешним API — курсы, Bot API, Taddy, постбэки — теперь идут через один клиент с меткой сервиса. Для игроков ничего не меняется; на этом строятся журнал запросов и прокси.
  ```
