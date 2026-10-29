---
id: T-0064
title: Курсы руками — «Обновить сейчас» у источника и запасной ручной курс любой валюты
epic: E13
priority: P2
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0063]
zones:
  - packages/fx/src/refresh.ts
  - packages/fx/src/manual.ts
  - packages/fx/test/refresh.test.ts
  - packages/fx/test/rates.test.ts
  - backend/api/src/modules/fx/fx.service.ts
  - backend/api/src/modules/fx/fx.refresher.ts
  - backend/api/src/modules/fx/dto/fx.dto.ts
  - backend/api/src/modules/admin/admin-fx.controller.ts
  - backend/api/test/fx.test.ts
  - backend/api/test/fx.integration.test.ts
  - apps/admin/src/api/fx.ts
  - apps/admin/src/screens/fx/FxScreen.tsx
  - apps/admin/test/fx.test.ts
shared:
  - apps/admin/src/ui/help.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0064. Курсы руками — «Обновить сейчас» у источника и запасной ручной курс любой валюты

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0064.json)](README.md#значки-статуса) [![T-0063](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0063.json&label=T-0063)](archive/T-0063-coinmarketcap-and-optional-keys.md)

## Зачем

Решения пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р90):

- **«Обновить сейчас»** — вызвать API конкретного источника по кнопке, а не
  ждать расписания: проверить, что источник отвечает, или подтянуть курс
  после сбоя;
- **ручной курс у любой валюты**, а не только у звёзд. У рыночной валюты он
  **запасной** (ответ пользователя): работает, только пока источники не дают
  свежего курса. Цены не встают, если API легли, и не расходятся с рынком,
  пока они работают.

## Решения

- **«Обновить сейчас»:**
  - запрашивает один источник сразу, мимо расписания, но в пределах
    лимитов:
    - остаток месяца кончился — отказ «Лимит источника на месяц исчерпан»;
    - с прошлого опроса прошло меньше `60 000 / perMinute` мс — отказ
      «Источник спрашивали только что — повторите через N с»;
  - проход — под тем же распределённым локом, что расписание: двух
    опросов одновременно нет. Лок занят — «Идёт обновление по расписанию,
    повторите через минуту»;
  - после опроса — новый снимок курсов;
  - ответ — что вернул источник: валюты и курсы, принят ли каждый, или
    причина сбоя.
- **Ручной курс рыночной валюты** (рубль, евро, Gram, USDT):
  - в снимок идёт, только если рыночного курса нет или он просрочен
    (`FRESHNESS_POLICY`);
  - котировка — только в долларах: цепочка ручных курсов друг через друга
    замкнулась бы;
  - срок годности — до 7 дней. Запас на время сбоя, а не способ
    зафиксировать курс;
  - в снимке источник курса — `manual:<кто>` и `fallback`: в панели видно,
    что работает запасной;
  - цель — только `price`: курс вывода (`payout`) есть только у валют
    площадок.
- **Ручной курс звёзд** — без изменений: у валют площадок рынка нет, и курс
  у них только ручной (срок — до 90 дней, как сейчас).

## Как сейчас

- **`packages/fx/src/refresh.ts`:**
  - `refreshRates({ sources, store, alerts, now })` пропускает источники,
    у которых `nextPollAt > now`, учитывает запрос в `usage`;
  - `takeSnapshot(store, now)`:
    - рыночные курсы — свежие из `store.currentRate`;
    - ручные — только для `kind === "platform"` (`store.currentManual`).
- **`packages/fx/src/manual.ts`:**
  - `manualRate(…)` — котировка не в валюте площадки;
  - `manualToRate`;
  - `MANUAL_RATE_PURPOSES`.
- **`packages/fx/src/budget.ts`** — `monthOf`, `Tariff`, `SourceUsage`;
  лимиты из панели — `effectiveTariff` (T-0062, `modules/fx/fx-limits.ts`).
- **`backend/api/src/modules/fx/dto/fx.dto.ts:15`** — `manualRateSchema`:
  - `currency` — только `platformCodes`;
  - `expiresInDays` 1…90.
- **`fx.refresher.ts`:**
  - лок `fx:refresh:lock`, `RELEASE_SCRIPT`;
  - `fxSources(…)`.
- **`fx.service.ts`** — `overview()`, `setManual(actor, input)`, аудит.
- **`admin-fx.controller.ts`** — `POST manual` под `fx.rates.edit`.
- **Панель** `screens/fx/FxScreen.tsx` — источники и форма ручного курса
  для звёзд.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`packages/fx/src/refresh.ts`:**
   - `refreshRates` — необязательный `force?: string` (id источника):
     - опросить только его, не глядя на `nextPollAt`;
     - остальное — как в обычном проходе: учёт запроса, сохранение,
       тревога при сбое;
   - `takeSnapshot` — в цикле рыночных валют:
     - рыночного нет или он `expired` →
       `store.currentManual(code, "price")`;
     - не просрочен → `manualToRate(manual, 1)` с источниками
       `[manual:<кто>, "fallback"]`.
3. **`packages/fx/src/manual.ts`:**

   ```ts
   export const MARKET_MANUAL_MAX_DAYS = 7;
   export const PLATFORM_MANUAL_MAX_DAYS = 90;
   ```

   `manualRate` у рыночной валюты отказывает, если котировка не доллар или
   цель не `price`.
4. **`fx.refresher.ts`:**

   ```ts
   export class FxRefreshBusyError extends Error {}
   /** Опросить один источник сейчас: под тем же локом, с проверкой лимитов, затем снимок. */
   refreshNow(source: string, now?: Date): Promise<RefreshNowResult>;
   ```

   - лок занят → `FxRefreshBusyError`;
   - лимит месяца — по `effectiveTariff`;
   - паузу в минуту проверить до опроса.
5. **`fx.service.ts`** — `refreshNow(actor, source)`:
   - неизвестный источник — 404;
   - аудит `fx.refresh.now` с источником и исходом;
   - доменные ошибки:
     - лимит — 409;
     - пауза — 429 с секундами;
     - занято — 409.

   Тексты — из «Решений».
6. **`dto/fx.dto.ts`** — `manualRateSchema`:
   - `currency` — любая, кроме доллара;
   - срок — по виду валюты (`MARKET_MANUAL_MAX_DAYS` или
     `PLATFORM_MANUAL_MAX_DAYS`);
   - рыночная — котировка `USD` и цель `price`, иначе 400 «У рыночной валюты
     ручной курс — запасной: в долларах и только для цен».
7. **`admin-fx.controller.ts`** — `POST sources/:source/refresh` под
   `fx.rates.edit`, лимит частоты 10 в минуту на аккаунт.
8. **Панель «Курсы»:**
   - у источника — кнопка «Обновить сейчас»; результат — уведомлением и
     строкой под таблицей: «CoinGecko ответил: Gram 5,41 $ — принят, USDT
     1,00 $ — принят» или причина отказа;
   - форма ручного курса — выбор любой валюты:
     - у рыночной — подсказка «Запасной: работает, только пока источники не
       дают свежего курса. До 7 дней»;
     - котировка — только «доллар», цель — только «цена»;
   - у курса, который сейчас взят из запасного ручного, — метка «запасной».
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Расписание опросов и лимиты (T-0062).
- Политику принятия курса (`accept.ts`).
- Ручной курс звёзд, кроме общего списка валют формы.

## Тесты

Первым коммитом.

- **`packages/fx/test/refresh.test.ts`:**
  - `force` опрашивает источник при `nextPollAt` в будущем и учитывает
    запрос;
  - снимок:
    - рыночный курс свежий — ручной рубля не берётся;
    - рыночный просрочен — берётся ручной, источники
      `[manual:<кто>, fallback]`;
    - ручной просрочен — курса рубля в снимке нет, как раньше.
- **`packages/fx/test/rates.test.ts`** — `manualRate`:
  - рубль в евро → отказ;
  - рубль с целью `payout` → отказ;
  - рубль в долларах на 7 дней → курс.
- **`backend/api/test/fx.test.ts`:**
  - `refreshNow`:
    - неизвестный источник — 404;
    - лимит месяца исчерпан — 409;
    - пауза — 429;
    - лок занят — 409;
    - успех — аудит и снимок;
  - схема ручного курса:
    - звёзды — до 90 дней;
    - рубль — до 7 дней и только `USD`/`price`.
- **`backend/api/test/fx.integration.test.ts`** — «Обновить сейчас» и
  проход по расписанию одновременно: опрос один.
- **`apps/admin/test/fx.test.ts`** — разбор результата обновления и метки
  «запасной».

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- **`docs/29-admin-panel.md`** — в строке раздела «Курсы»: «Обновить сейчас»
  и запасной ручной курс рыночной валюты. Решение уже записано в Р90.

## Критерии приёмки

- [ ] «Обновить сейчас» опрашивает источник сразу, в пределах лимитов, и
  показывает, что он вернул.
- [ ] Ручной курс задаётся любой валюте. У рыночной он работает, только
  когда свежего рыночного нет, и это видно в панели.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(fx): Кнопка «Обновить сейчас» и запасной ручной курс`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КУРСЫ РУКАМИ**

  В «Курсах» у каждого источника есть «Обновить сейчас»: источник спрашивается сразу, и видно, что он ответил. Ручной курс теперь задаётся любой валюте; у рубля, Gram и других рыночных валют он запасной — работает, только пока источники не дают свежего курса, до 7 дней.
  ```
