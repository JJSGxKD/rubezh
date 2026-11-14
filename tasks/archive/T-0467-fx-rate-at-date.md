---
id: T-0467
title: Курс на дату из истории курсов — для оценки проводок при закрытии месяца
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/fx/fx-history.ts
  - backend/api/test/fx-history.test.ts
  - backend/api/test/fx-history.integration.test.ts
shared:
  - backend/api/src/modules/fx/fx.store.ts
  - backend/api/src/modules/fx/fx.service.ts
  - backend/api/src/modules/fx/fx.module.ts
  - backend/api/test/fx.test.ts
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0467. Курс на дату из истории курсов — для оценки проводок при закрытии месяца

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0467.json)](../README.md#значки-статуса)

## Зачем

Закрытие месяца оценивает каждую проводку по курсу её дня (О46, Р222):
выручку в звёздах — по курсу выплаты на дату оплаты, рубли и Gram — по
рыночному курсу на дату. Ядро курсов хранит историю, но отвечает только
«курсом на сейчас». Задача даёт серверу курс на любую прошлую дату и
говорит честно, когда его нет.

## Решения

- `docs/35-stage4-plan.md`, **Р219** (О46), **Р222**.
- Рыночные валюты — `fx_rate_history`: последняя строка с
  `accepted_at ≤ дата`; звезда (`XTR`) — `fx_manual_rate` с
  `purpose = 'payout'`: последняя строка с `set_at ≤ дата`; ручной курс в
  рублях пересчитывается через рыночный курс рубля **на ту же дату**.
- Курс старше 7 дней до даты (у звезды — истёкший `expires_at` на дату) —
  отдаётся с признаком `stale`: закрытие покажет предупреждение, а не
  молча возьмёт старое. Курса нет совсем — `null`: блокер закрытия.

## Как сейчас

- Модели `FxRateHistory` (`currency`, `usd_per_unit`, `accepted_at`,
  индекс `(currency, accepted_at)`) и `FxManualRate` (`currency`, `purpose`,
  `price`, `quote`, `set_at`, `expires_at`, индекс `(currency, purpose, set_at)`)
  — `schema.prisma`, строки ~913–940.
- `FxService.peek(now)` (T-0453) — только «на сейчас».

## Шаги по порядку

1. `fx.store.ts`: `historyAt(currency, at)` и `manualAt(currency, purpose, at)`
   — по одной строке, по индексам, без выборки всей истории.
2. `fx-history.ts`: `rateAt(currency, at): Promise<{ usdPerUnit: Decimal; at: Date; stale: boolean; source: "market" | "manual" } | null>`
   — `USD` — 1; рыночные — из истории; `XTR` — из ручного выплаты с
   пересчётом котировки; `ratesAt(pairs)` — пакетом для многих дат (закрытие
   оценивает сотни проводок: один запрос на валюту и границу дня, кэш в
   пределах вызова, без запросов в цикле).
3. `FxService.rateAt` / `ratesAt` — тонкая обёртка.
4. `docs/35-stage4-plan.md` §3.12 (курсы) — абзац «Курс на дату»: откуда, что
   такое `stale`, когда `null`.

## Чего не трогаем

- Принятие курсов, источники, снимки цен.
- Закрытие месяца — T-0468.

## Сценарий и интерфейс

- `rateAt("XTR", 2026-11-01T12:00Z)` → курс выплаты, заданный 28 октября,
  `stale: false`; `rateAt("RUB", 2026-01-02)` до первой записи истории →
  `null`.

## Тесты

Первым коммитом:

- `backend/api/test/fx-history.test.ts` (на подменённом хранилище): USD —
  1; рынок — последняя не позже даты; старше 7 дней — `stale`; звезда в
  рублях — через рубль той же даты; рубля на дату нет — `null`; пакет на
  200 дат — запросов к хранилищу не больше, чем валют × уникальных дней.
- `backend/api/test/fx-history.integration.test.ts` (Postgres): границы
  `accepted_at` и `set_at` ровно на дату включаются.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/35-stage4-plan.md`.

## Критерии приёмки

- [ ] Курс любой валюты проекта на прошлую дату — из истории, звезда — по
      курсу выплаты на ту дату.
- [ ] Старый курс помечен `stale`, отсутствующий — `null`.
- [ ] Пакетный запрос не делает запросов в цикле.
- [ ] Тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(fx): Курс на дату из истории`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КУРС НА ДАТУ ИЗ ИСТОРИИ**

  Ядро курсов отвечает курсом на любую прошлую дату (Р222): рыночные
  валюты — из истории, звезда — по курсу выплаты на ту дату. На нём закрытие
  месяца оценит каждую проводку по курсу её дня.

  🛠 **Что внутри**

  • старый курс помечен — закрытие предупредит
  • курса нет — блокер закрытия, а не догадка
  ```
