---
id: T-0062
title: Лимиты источников курсов в панели — сколько осталось, правка лимита и счётчика, предупреждения
epic: E13
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0059]
zones:
  - backend/api/src/modules/fx/fx.refresher.ts
  - backend/api/src/modules/fx/fx.service.ts
  - backend/api/src/modules/fx/fx.store.ts
  - backend/api/src/modules/fx/fx-hooks.ts
  - backend/api/src/modules/fx/fx-limits.ts
  - backend/api/src/modules/fx/dto/fx.dto.ts
  - backend/api/src/modules/admin/admin-fx.controller.ts
  - backend/api/src/modules/admin-notify/fx-alert-notifier.ts
  - backend/api/test/fx.test.ts
  - backend/api/test/fx-limits.test.ts
  - backend/api/test/fx.integration.test.ts
  - apps/admin/src/api/fx.ts
  - apps/admin/src/screens/fx/FxScreen.tsx
  - apps/admin/test/fx.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - apps/admin/src/ui/help.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
version: v0.9
---

# T-0062. Лимиты источников курсов в панели — сколько осталось, правка лимита и счётчика, предупреждения

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0062.json)](README.md#значки-статуса) [![T-0059](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0059.json&label=T-0059)](T-0059-outbound-http-client.md)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р89): у ключа
внешнего API есть лимит запросов (у CoinGecko Demo — 10 000 в месяц), и
команда должна видеть остаток и править его.

Сейчас:

- **ядро курсов уже считает расход.** У источника — счётчик запросов за
  месяц (`fx_source_state.used`), и опросы растягиваются на месяц по тарифу
  из кода (`Tariff.perMonth`, `packages/fx/src/budget.ts`);
- **кончился остаток** — следующий опрос откладывается до нового месяца.

Не хватает:

- лимита рядом со счётчиком — «6 120 из 10 000»;
- правки лимита, когда поставщик поменял тариф: сейчас это релиз;
- правки счётчика, когда он разошёлся с кабинетом поставщика;
- предупреждений команде на 80% и 100%.

## Решения

- **Лимит источника — тариф из кода, если в панели не задан другой.**
  - Заданный лимит — запросов в календарный месяц UTC; «без лимита» — тоже
    значение.
  - Сброс возвращает тариф.
  - Лимит в минуту и минимальный интервал не правятся: это защита
    поставщика, а не тариф.
- **Правка счётчика** — новое значение за текущий месяц с причиной. С
  новым месяцем счётчик, как и сейчас, начинается с нуля.
- **Предупреждения** — в чат, куда уже уходят сообщения о курсах
  (`fx-alert-notifier.ts`), по разу за месяц на порог:
  - **80%** — «CoinGecko: израсходовано 8 000 из 10 000 запросов за
    октябрь (80%). Курс опрашивается реже, до 1 ноября хватит»;
  - **100%** — «CoinGecko: лимит 10 000 запросов за октябрь исчерпан.
    Источник молчит до 1 ноября, курс берут остальные».
- **Права**:
  - видеть — как раздел «Курсы» (`analytics.revenue.view`);
  - править лимит и счётчик — как ручной курс (`fx.rates.edit`).

  Каждая правка — в аудит «было → стало».

## Как сейчас

- **`packages/fx/src/budget.ts`:**
  - `Tariff { name, perMinute, perMonth, minIntervalMs }`;
  - `nextPollDelayMs` (остатка нет — ждём новый месяц);
  - `recordPoll`, `monthOf`.
- **Тарифы источников** — в `packages/fx/src/sources/*` (`COINGECKO_TARIFFS`
  и другие); `RateSource.tariff`.
- **`backend/api/src/modules/fx/fx.refresher.ts`:**
  - `fxSources(…)` (после T-0059 — с клиентом исходящих);
  - проход раз в минуту под локом → `refreshRates({ sources, store, alerts, now })`;
  - `alerts.sourceFailed` → `this.hooks.emit({ kind: "source_failed", … })`.
- **`fx.store.ts:82-90`** — `sourceState` и `saveSourceState`, таблица
  `fx_source_state` (`source`, `month`, `used`, `pausedUntil`, `nextPollAt`).
- **`fx.service.ts:90`** — `overview()` отдаёт по источнику `tariff` (имя),
  `month`, `used`, `pausedUntil`.
- **`admin-fx.controller.ts`:**
  - `GET` под `analytics.revenue.view`;
  - `POST manual` под `fx.rates.edit`.
- **`fx-hooks.ts`** — виды событий; **`admin-notify/fx-alert-notifier.ts`**
  — тексты `fxAlertText` и отправка в общий чат.
- **Панель** `screens/fx/FxScreen.tsx` — таблица источников с колонками
  «Запросов за месяц» и «Пауза до».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция:**

   ```prisma
   // Лимит источника курсов из панели (docs/35-stage4-plan.md Р89, T-0062): строки нет — тариф из кода.
   model FxSourceLimit {
     source    String   @id @db.VarChar(32)
     /// запросов в календарный месяц UTC; null — без месячного лимита
     perMonth  Int?     @map("per_month")
     note      String   @db.VarChar(200)
     updatedBy String   @map("updated_by") @db.Uuid
     updatedAt DateTime @map("updated_at") @db.Timestamptz(3)
     @@map("fx_source_limit")
   }
   ```

3. **Новый `fx/fx-limits.ts`** — чистые функции:

   ```ts
   /** Тариф с лимитом из панели; `override` — `undefined`, если строки нет. */
   export function effectiveTariff(tariff: Tariff, override: { perMonth: number | null } | undefined): Tariff;
   export type BudgetThreshold = 80 | 100;
   /** Какие пороги перешли между двумя значениями счётчика того же месяца. */
   export function crossedThresholds(before: number, after: number, perMonth: number | null): BudgetThreshold[];
   ```

4. **`fx.refresher.ts`:**
   - перед проходом:
     - читать лимиты (`fx.store`);
     - подменить у источников тариф на `effectiveTariff` — новым объектом
       `{ ...source, tariff }`, сам источник не меняется;
     - запомнить `used` каждого источника;
   - после прохода — `crossedThresholds`; порог, перейдённый впервые за
     месяц, — событие `{ kind: "source_budget", source, used, perMonth, threshold }`.
   - «впервые» — `SET fx:budget:<source>:<месяц>:<порог> NX EX 3024000`
     (35 суток) в Redis: повтор прохода и вторая реплика второго сообщения
     не дадут.
5. **`fx.store.ts`:**
   - `limits()`, `setLimit(source, perMonth, note, actor)`,
     `resetLimit(source)`;
   - `setUsed(source, used, month)` — `UPDATE … SET used, month` одним
     запросом. `nextPollAt` не трогать: следующий опрос пересчитает его
     сам.
6. **`fx.service.ts`:**
   - в `overview()` у источника:
     - `limit: { perMonth: number | null; from: "tariff" | "panel" }`;
     - `usedShare: number | null` — доля от лимита;
   - `setLimit`, `resetLimit`, `correctUsed(actor, source, used, note)` —
     с аудитом `fx.limit.set`, `fx.limit.reset`, `fx.used.correct`.
     Неизвестный источник — 404.
7. **`admin-fx.controller.ts`** — под `fx.rates.edit`:
   - `PUT sources/:source/limit` `{ perMonth: number | null, note }`;
   - `DELETE sources/:source/limit`;
   - `PUT sources/:source/used` `{ used, note }`.

   Пределы: `perMonth` 1…100 000 000 или `null`, `used` 0…100 000 000,
   `note` 3…200 после `trim`.
8. **`fx-hooks.ts` и `fx-alert-notifier.ts`** — вид `source_budget` и
   тексты из «Решений». Имя источника и месяц — так же, как в соседних
   текстах; дата «до 1 ноября» — начало следующего месяца по UTC.
9. **Панель «Курсы»:**
   - у источника — «Израсходовано»:
     - «6 120 из 10 000» с полосой и долей;
     - «без лимита» — без полосы;
     - от 80% — тоном предупреждения, 100% — опасности;
   - подпись лимита: «по тарифу «Demo»» или «задан в панели»;
   - действия в строке:
     - «Изменить лимит…» — окно: число или «без лимита», причина, «Сбросить
       к тарифу»;
     - «Поправить счётчик…» — окно: число, причина, подсказка «если
       расходится с кабинетом поставщика»;
   - пояснение `HELP.fx.limit` — «Сколько запросов источник даёт в месяц по
     тарифу. Опросы растягиваются на месяц, чтобы лимита хватило; кончился —
     источник молчит до нового месяца, курс берут остальные».
10. **Документы** — раздел «Документы».

## Чего не трогаем

- Ядро `@bh/fx`: тариф подменяется снаружи.
- Новые источники и ключи — T-0063.
- Ручные курсы и «Обновить сейчас» — T-0064.

## Тесты

Первым коммитом.

- **`backend/api/test/fx-limits.test.ts`:**
  - `effectiveTariff`:
    - без строки — тариф как есть;
    - 20 000 — `perMonth` 20 000, прочее прежнее;
    - `null` — без месячного лимита;
  - `crossedThresholds`:
    - 7 999 → 8 000 при 10 000 → `[80]`;
    - 7 000 → 10 000 → `[80, 100]`;
    - 8 500 → 9 000 → `[]`;
    - лимит `null` → `[]`.
- **`backend/api/test/fx.test.ts`:**
  - `overview` отдаёт лимит из тарифа и из панели, долю;
  - правки:
    - без `fx.rates.edit` — отказ;
    - неизвестный источник — 404;
    - аудит «было → стало».
- **`backend/api/test/fx.integration.test.ts`** (Postgres, Redis 13):
  - порог 80% даёт одно событие за месяц, второй проход — ни одного;
  - `setUsed` меняет счётчик текущего месяца.
- **`apps/admin/test/fx.test.ts`** — разбор `limit` и `usedShare`; тон по
  доле: 0,79 — обычный, 0,8 — предупреждение, 1 — опасность.

## Аналитика

Нет: это эксплуатация.

## Настройки и окружение

Нет. Лимит — данные панели (`fx_source_limit`), не настройка каталога: у
каждого источника свой, с причиной и сбросом к тарифу.

## Документы

- **`docs/21-diagrams.md`** — ER: `fx_source_limit`.
- **`docs/30-configuration-map.md`** — строка: лимит источника курсов —
  панель «Курсы», умолчание — тариф в `packages/fx/src/sources/*`.

## Критерии приёмки

- [ ] В «Курсах» у источника видно «израсходовано из лимита» и откуда
  лимит.
- [ ] Лимит меняется и сбрасывается к тарифу; счётчик правится. Каждая
  правка — в аудите, опросы сразу идут по новому лимиту.
- [ ] На 80% и 100% — по одному сообщению за месяц.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(fx): Лимиты источников курсов в панели`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛИМИТЫ ИСТОЧНИКОВ КУРСОВ**

  В «Курсах» видно, сколько запросов каждый источник израсходовал из месячного лимита. Лимит можно поменять, если поставщик сменил тариф, а счётчик — поправить, если он разошёлся с кабинетом. На 80% и 100% придёт сообщение.
  ```
