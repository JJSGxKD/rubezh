---
id: T-0069
title: Постбэки — слой «событие → назначение», AdsGram первым назначением
epic: E14
priority: P2
status: ready
owner:
author: claude-lead2-2
size: M
depends_on: [T-0059]
zones:
  - backend/api/src/modules/ad-conversions/**
  - backend/api/test/ad-conversions.test.ts
  - backend/api/test/ad-conversions.integration.test.ts
  - backend/api/test/postback-destinations.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: extra
release: patch
design: null
batch: 3
---

# T-0069. Постбэки — слой «событие → назначение», AdsGram первым назначением

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0069.json)](README.md#значки-статуса) [![T-0059](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0059.json&label=T-0059)](T-0059-outbound-http-client.md)

## Зачем

Нынешняя отправка конверсий знает одного получателя, AdsGram, и зашита в него
целиком: партнёр или сеть с другим форматом потребовали бы переписать проход.
После задачи игра порождает внутренние события, а получатели (назначения)
подключаются к ним как отдельные адаптеры. Для игрока и для команды ничего не
меняется: в AdsGram уходит то же самое, в тех же форматах и с теми же повторами.
Это подготовка под T-0070 и T-0071.

## Решения

Записаны в `docs/35-stage4-plan.md` Р86, Р96, О39 (WP43, WP49 часть 4) и в
`tasks/inbox.md` («Постбэки — общий слой адаптеров»). Исполнитель их не пересматривает.

- **События:** `registration`, `purchase_first`, `purchase_repeat`, `d1_return`. Здесь
  порождаются первые три, как сейчас; код `d1_return` закладываем, чтобы в T-0071 не было миграции.
- **Назначения:** `adsgram`, `s2s`, `partner`. Реализуется `adsgram`; остальные допустимы в
  базе и типах, адаптеры — T-0070. У AdsGram три фиксированных события (`goaltype` 1–3),
  `d1_return` он не получает никогда.
- **Поведение AdsGram не меняется:** адрес, окна О39, паузы повторов, пропуск аккаунтов
  команды, ожидание токена, журнал и «Отправить ещё раз».
- **Схема — expand → migrate → contract** (`docs/09-ci-cd.md`): колонка `goal` остаётся и
  хранит код события (1–3 как `goaltype`, 4 — `d1_return`); откат кода схему не ломает.
- **Идентификатор события** для приёмника — `conversion_id`: один на событие и назначение,
  при повторах не меняется.
- Отправка идёт через общий клиент T-0059 (`outbound.forService("ads.postback")`).

## Как сейчас

`backend/api/src/modules/ad-conversions/`:

- `conversion-rules.ts` — `ConversionGoal = 1 | 2 | 3`, `CONVERSION_WINDOWS`, `RETRY_DELAYS_MIN`,
  `retryAt`, `verdictOf`, `adsgramPostbackUrl`, `redacted`.
- `conversions.repository.ts`: `sweep` (стр. 95-157) — два `INSERT … SELECT … ON CONFLICT DO NOTHING`,
  сеть из `link.network`, цель покупки `CASE WHEN paid.n = 1 THEN 2 ELSE 3`; `due` (159-176) —
  `DueConversion { conversionId, network, goal, attempts, params, telegramId }`; `goalOf` (84)
  превращает любое неизвестное число в `1`; `summaries` (212), `journal`, `requeue`.
- `conversions.service.ts`: `send` (98-135) — сеть не `adsgram` → `skip("unknown_network")`,
  токена нет → `defer("no_token")`, адреса нет → `skip("no_macros")`, иначе `fetch` с таймаутом
  5 с и `verdictOf`; `tick` — проход раз в минуту под локом Redis.
- `ad_conversion` (`migrations/20261002180000_ad_conversions`): `CHECK goal BETWEEN 1 AND 3`,
  `CHECK (goal = 1) = (purchase_id IS NULL)`, уникальны `purchase_id` и `(click_id, goal)` при
  `goal IN (1, 2)`. В `schema.prisma` (стр. ~2091) у `Purchase` одна связь `adConversion`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (`prisma migrate dev --create-only` на отдельной базе, один раз,
   после перебазирования на свежий `dev`; индексы с условием — рукой, по образцу
   `20261002180000_ad_conversions`):

   ```sql
   ALTER TABLE "ad_conversion"
     ADD COLUMN "destination" VARCHAR(16) NOT NULL DEFAULT 'adsgram',
     ADD CONSTRAINT "ad_conversion_destination_check" CHECK ("destination" IN ('adsgram', 's2s', 'partner'));
   ALTER TABLE "ad_conversion" DROP CONSTRAINT "ad_conversion_goal_check", DROP CONSTRAINT "ad_conversion_purchase_check";
   ALTER TABLE "ad_conversion"
     ADD CONSTRAINT "ad_conversion_goal_check" CHECK ("goal" BETWEEN 1 AND 4),
     ADD CONSTRAINT "ad_conversion_purchase_check" CHECK (("goal" IN (2, 3)) = ("purchase_id" IS NOT NULL));
   DROP INDEX "ad_conversion_purchase_id_key";
   DROP INDEX "ad_conversion_click_id_goal_key";
   CREATE UNIQUE INDEX "ad_conversion_purchase_id_destination_key" ON "ad_conversion"("purchase_id", "destination");
   CREATE UNIQUE INDEX "ad_conversion_click_id_goal_destination_key" ON "ad_conversion"("click_id", "goal", "destination") WHERE "goal" IN (1, 2, 4);
   ```

   В `schema.prisma`: `destination String @default("adsgram") @db.VarChar(16)`,
   `@@unique([purchaseId, destination])` вместо `@unique` у `purchaseId`, а у
   `Purchase` связь становится списком `adConversions AdConversion[]`. Места, где
   код читает `purchase.adConversion`, находит `pnpm typecheck` (корневой) и
   `grep -rn adConversion backend/api/src`. Комментарий над `goal`: «код
   события: 1 — регистрация, 2 — первая покупка, 3 — повторная (совпадают с
   `goaltype` AdsGram), 4 — возврат на следующий день».
3. **Новый `ad-conversions/postback-events.ts`:**

   ```ts
   export const POSTBACK_EVENTS = ["registration", "purchase_first", "purchase_repeat", "d1_return"] as const;
   export type PostbackEvent = (typeof POSTBACK_EVENTS)[number];
   export const EVENT_GOAL = { registration: 1, purchase_first: 2, purchase_repeat: 3, d1_return: 4 } as const satisfies Record<PostbackEvent, number>;
   /** Событие по коду из базы; неизвестный код — ошибка, а не «регистрация». */
   export function eventOfGoal(goal: number): PostbackEvent;
   ```

   `goalOf` в репозитории удалить: он превращал любой неизвестный код в
   регистрацию, и строка с кодом 4 ушла бы в AdsGram как регистрация. Везде, где
   нужен `ConversionGoal` AdsGram, берётся `EVENT_GOAL` через проверку, что
   событие — одно из трёх.
4. **Новый `ad-conversions/destinations/destination.ts`:**

   ```ts
   export const DESTINATION_KINDS = ["adsgram", "s2s", "partner"] as const;
   export type DestinationKind = (typeof DESTINATION_KINDS)[number];

   /** Что назначение решило про одну отправку. */
   export type Prepared =
     | { kind: "request"; url: URL; init?: RequestInit; logUrl: string }   // logUrl — без секретов
     | { kind: "wait"; reason: string; recheckMin: number }               // ждёт настройки (нет токена), попытка не тратится
     | { kind: "skip"; reason: string }                                    // отправить нельзя совсем
     | { kind: "fail"; message: string; retry: boolean };                  // не прошло проверку; retry — повторить по расписанию

   export interface PostbackDestination {
     readonly kind: DestinationKind;
     /** События, которые назначение вообще умеет принимать. */
     readonly accepts: readonly PostbackEvent[];
     prepare(conversion: DueConversion): Promise<Prepared>;
   }
   export const POSTBACK_DESTINATIONS = Symbol("POSTBACK_DESTINATIONS");
   ```

5. **Новый `destinations/adsgram.destination.ts`** — класс `AdsgramDestination`
   (`kind: "adsgram"`, `accepts`: три события). Конструктор берёт `SecretsReader`.
   `prepare` переносит ветки из `send`: токена нет → `wait` (`reason: "no_token"`,
   `recheckMin: NO_TOKEN_RECHECK_MIN`); `adsgramPostbackUrl` вернул `null` →
   `skip("no_macros")`; иначе `request` с `logUrl: redacted(url)`. Цель для
   `adsgramPostbackUrl` — `EVENT_GOAL[event]`.
6. **Новый `destinations/destination-targets.ts`** — единственная точка, где
   запросы прохода узнают, кому и что отправлять:

   ```ts
   /** CTE `targets(link_code, destination, events, since)`: у какой ссылки какие назначения и что они получают. */
   export const TARGETS_CTE: Prisma.Sql;
   ```

   Сейчас одна ветка: `SELECT l.code, 'adsgram', ARRAY['registration','purchase_first','purchase_repeat'], '-infinity'::timestamptz FROM link l WHERE l.network = 'adsgram'`.
   T-0070 допишет ветки через `UNION ALL`, не трогая запросы.
7. **`conversions.repository.ts`:**
   - `sweep`: оба запроса начинаются с `WITH ${TARGETS_CTE}`, регистрации и покупки
     берутся `FROM targets t JOIN link l ON l.code = t.link_code`, в `INSERT`
     пишутся `destination` и `goal = EVENT_GOAL[…]`; условия окон и пропуск
     аккаунтов команды не меняются. Событие попадает в вставку только при
     `'registration' = ANY(t.events)` (для покупок —
     `'purchase_first'` / `'purchase_repeat'` по номеру оплаты) и `c.at >= t.since`.
     Номер покупки по-прежнему считается по всем настоящим оплатам аккаунта, а не
     по назначению. В колонку `network` (она `NOT NULL` и нужна старому коду при
     откате) пишется `t.destination`, а не `l.network`: у ссылок без сети (T-0070)
     последнего значения нет. Читать нужно `destination`;
   - `DueConversion` теперь `{ conversionId, destination: DestinationKind, event: PostbackEvent, attempts, params, telegramId, purchase: { amount: number; currency: string } | null }`.
     `purchase` — из `LEFT JOIN purchase p`: `amount = p.charged_stars`,
     `currency = PAYMENT_CURRENCY`. Константа `PAYMENT_CURRENCY = "XTR"` в
     `conversion-rules.ts` с комментарием: валюта платежа как заплачено, без
     пересчёта (`docs/37-accounting.md`, О44); появится колонка валюты у покупки —
     берём её;
   - `summaries(linkCodes, destination = "adsgram")` — считает только строки
     этого назначения, чтобы будущие строки партнёра не попали в строку «отправлено
     в AdsGram»;
   - `ConversionRow` += `event: PostbackEvent`, `destination: DestinationKind`;
     `goal` остаётся.
8. **`conversions.service.ts`:**
   - конструктор получает `@Inject(POSTBACK_DESTINATIONS) destinations: PostbackDestination[]`
     и `Outbound` из T-0059 (отправка идёт через `outbound.forService("ads.postback")`;
     параметр `fetchImpl` в `tick` остаётся для тестов);
   - `send`: назначения нет в реестре или оно не принимает событие →
     `skip("unknown_network")` (причина прежняя, чтобы не менять тексты панели);
     дальше `prepare` и разбор по `kind`:
     `wait` → `defer(…, nextAt, reason)`; `skip` → `skip`; `fail` → `markFailed`
     с `message`, `nextAt = retry ? retryAt(attempts, now) : null`; `request` →
     `fetch` с `AbortSignal.timeout(POSTBACK_TIMEOUT_MS)` и разбор ответа как сейчас;
     в лог — `logUrl`, никогда `url`;
   - разбор ответа и ошибок вынесен в приватный метод `deliver(conversion, prepared, …)`:
     сервис остаётся короче 300 строк.
9. **`ad-conversions.module.ts`:** провайдер `POSTBACK_DESTINATIONS` —
   `useFactory: (secrets) => [new AdsgramDestination(secrets)]`, `inject: [SECRETS_READER]`.
10. **Документы** — раздел «Документы».

## Чего не трогаем

- Формат запроса AdsGram, `adsgramPostbackUrl`, `verdictOf`, `RETRY_DELAYS_MIN`, `CONVERSION_WINDOWS`.
- Панель и `admin-links.controller.ts`: они импортируют `ConversionRow`, `emptySummary`,
  `ConversionSummary` и читают `goal` — имена остаются. Назначение в журнале — T-0070.
- Переходник и `link_click.network_params` — T-0070. Новые назначения, шаблон адреса,
  `d1_return` — T-0070 и T-0071. Другие вызовы внешних API — T-0059.

## Сценарий и интерфейс

Нет: для игрока и панели ничего не меняется.

## Тесты

Первым коммитом, до кода. Юнит — на подменах, интеграционные — на живых Postgres и Redis
(`docs/17-testing-strategy.md` §4.2).

- `backend/api/test/postback-destinations.test.ts` (новый):
  - `eventOfGoal(1|2|3|4)` → четыре события; `0` и `5` → ошибка;
  - `AdsgramDestination.accepts` — три события, без `d1_return`;
  - `prepare` с токеном и `params.record` → `request`, `logUrl` с `token=***` и без самого токена;
    без токена → `wait` (`recheckMin` 5); токен есть, макросов нет → `skip("no_macros")`.
- `backend/api/test/ad-conversions.test.ts` — кейсы «отправка» с прежними ожиданиями (2xx, 5xx
  с повтором, отказ, таймаут, нет токена, нет макросов, лок). Новые: подменное назначение
  отвечает `fail { retry: false }` → `failed` без повторов, текст сохранён; `retry: true` → повтор
  по расписанию; в лог идёт `logUrl`, не `url`; назначения нет в реестре → `skipped`, причина
  `unknown_network`.
- `backend/api/test/ad-conversions.integration.test.ts` (живой Postgres) — прежние кейсы с теми
  же ожиданиями. Новые:
  - строки пишутся с `destination = 'adsgram'` и `network = 'adsgram'`;
  - два `sweep` через `Promise.all` → по одной строке на (клик, цель, назначение), без ошибок;
  - две строки одной цели одного клика допустимы при разных назначениях и недопустимы при
    одинаковых; то же для одной оплаты;
  - `goal = 4` без оплаты проходит проверки таблицы, с оплатой — нет, `goal = 5` — нет; такая
    строка не читается как регистрация и пропускается (`unknown_network`);
  - `due` у покупки отдаёт `purchase.amount` = списанным звёздам и `currency = "XTR"`, у регистрации
    `purchase = null`;
  - `summaries(codes, "adsgram")` не считает строку другого назначения.

## Аналитика

Нет. Журнал отправок — таблица `ad_conversion`, как в WP43; событие серверу не
нужно (`docs/35-stage4-plan.md` WP43, «Аналитика»).

## Настройки и окружение

Нет. Числа остаются в `conversion-rules.ts`; новая константа `PAYMENT_CURRENCY`
не настраивается.

## Документы

- `docs/35-stage4-plan.md`, WP43 «Как сделано» — абзац «Слой назначений
  (13.10.2026)»: события, назначения, `destination`, код события в `goal`.
- `docs/21-diagrams.md` — ER: у `ad_conversion` колонка `destination`, обновлённые
  ключи; схема модулей: узел `ADCONV` пишет «событие → назначение».
- `docs/30-configuration-map.md`, строка про конверсии закупок — добавить
  `destinations/destination-targets.ts` (какие события получает назначение).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: `goal` остаётся кодом события (1–4), переименование в
  `event` — отдельным шагом «contract» позже, чтобы откат релиза не ломал схему.
- Подтверждено `claude-lead-1` 13.10.2026: причина пропуска для неизвестного назначения осталась
  `unknown_network`, чтобы не менять тексты панели.

## Критерии приёмки

- [ ] Проход, очередь, повторы, журнал и «Отправить ещё раз» работают как раньше: прежние кейсы
  обоих тестовых файлов зелёные без смягчения ожиданий.
- [ ] Отправка в AdsGram идёт через `AdsgramDestination`, сервис не знает про
  `adsgramPostbackUrl`; в `network` новых строк лежит имя назначения.
- [ ] Новое назначение подключается провайдером в `POSTBACK_DESTINATIONS` и веткой в
  `TARGETS_CTE`, без правки `send`, `deliver` и запросов прохода.
- [ ] Таблица допускает по строке на (клик, цель, назначение) и (оплата, назначение); цель 4
  допустима; миграция не удаляет колонок; неизвестный код цели не читается как регистрация.
- [ ] Токена нет ни в логе, ни в журнале, ни в ответе панели.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-листы безопасности и нагрузки
  (`docs/15-engineering-standards.md` §7, §8) и план отката миграции (откат кода без отката схемы).

## PR

- **Заголовок:** `refactor(api): Слой «событие → назначение» для постбэков`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОСТБЭКИ: СЛОЙ «СОБЫТИЕ → НАЗНАЧЕНИЕ»**

  Отправка конверсий разделена на события игры и назначения: AdsGram стал первым назначением, остальные подключаются адаптерами. Для игроков и панели ничего не меняется.

  🛠 **Что внутри**

  • таблица конверсий помнит назначение, уникальность — на (клик, цель, назначение)
  • миграция только добавляет, откат релиза схему не ломает
  ```
