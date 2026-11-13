---
id: T-0463
title: Шаблоны повторяющихся расходов — черновики операций периода одним действием
epic: E15
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0461]
zones:
  - backend/api/src/modules/ledger/templates/**
  - backend/api/test/ledger-templates.test.ts
  - backend/api/test/ledger-templates.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/test/admin-ledger.http.test.ts
  - docs/21-diagrams.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0463. Шаблоны повторяющихся расходов — черновики операций периода одним действием

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0463.json)](README.md#значки-статуса) [![T-0461](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0461.json&label=T-0461)](T-0461-ledger-manual-operations.md)

## Зачем

Сервер, CDN, ИИ-инструменты оплачиваются каждый месяц, домены — раз в год
(Р220). Вносить их каждый раз с нуля — долго и легко забыть. Шаблон хранит
статью, место, обычную сумму и график; одно действие «Расходы месяца»
создаёт черновики операций, которые человек сверяет с фактом и проводит.

## Решения

- `docs/35-stage4-plan.md`, **Р220**; `docs/29-admin-panel.md` §6.2
  («Шаблон — создаётся в месяц одним действием»).
- Шаблон **не проводит сам**: только черновик (`draft`) — сумма в
  реальности могла измениться (курс, тариф).
- График: `monthly` (каждый месяц) или `yearly` (месяц года). Черновик по
  шаблону на период — **один** (`@@unique([template_id, template_period])`
  в `ledger_operation`, T-0461): повторное действие не плодит дублей.
- Шаблоны на старте не заводятся кодом: суммы и места знает только
  владелец; пустой список с подсказкой (экран — T-0465).

## Как сейчас

- `ledger_operation` с `template_id` и `template_period` (T-0461);
  `OperationsService.create` создаёт черновик расхода.
- Статьи и места — T-0460.

## Шаги по порядку

1. **Схема и миграция** `<время>_ledger_templates`: `ledger_template` —
   `template_id varchar(64) pk` (slug из названия), `name varchar(128)`,
   `article_id`, `place_account_id`, `amount bigint` (минимальные единицы
   валюты места), `schedule` (`monthly` | `yearly`), `month smallint null`
   (1…12, для `yearly`), `note varchar(500)`, `archived_at`, `created_at`,
   `created_by`.
2. **Чистые правила** `templates/schedule.ts`: `isDue(template, period)` —
   `monthly` — всегда, `yearly` — если месяц совпал; `draftInput(template, period)`
   — вход операции `expense` (место, статья, сумма, `at` — первое число
   периода, `note` — «<название> за <месяц год>»).
3. **Сервис** `templates/templates.service.ts`: CRUD шаблонов (право
   `finance.entry.create`, аудит `ledger.template.*`), `draftPeriod(actor, period)`
   — для всех активных шаблонов с `isDue` создаёт черновики через
   `OperationsService.create` с `template_id`/`template_period`; уже
   созданные пропускает; ответ — сколько создано и сколько уже было.
4. **Маршруты**: `GET/POST /templates`, `PATCH /templates/:id`,
   `POST /templates/:id/archive`, `POST /templates/draft-period`
   `{ period: "YYYY-MM" }` (не раньше прошлого месяца и не позже
   следующего).
5. **Документы**: `docs/21-diagrams.md` — ER `ledger_template`;
   `docs/37-accounting.md` §8 — строка «Шаблоны расходов».

## Чего не трогаем

- Сами операции и второй ключ — T-0461, T-0462.
- Автопроводку по шаблону без человека — не делаем.

## Сценарий и интерфейс

- Шаблоны «VPS — 1 500 ₽ с карты, каждый месяц» и «Домены — 3 200 ₽,
  март». В ноябре «Расходы месяца» → один черновик (VPS); в марте — два.
  Второй раз в ноябре — «создано 0, уже было 1».

## Тесты

Первым коммитом:

- `backend/api/test/ledger-templates.test.ts`: `isDue` для `monthly` и
  `yearly`; `draftInput` — сумма, место, статья, дата первого числа,
  текст с месяцем по-русски.
- `backend/api/test/ledger-templates.integration.test.ts` (Postgres): два
  одновременных `draftPeriod` на один период — черновиков столько же, сколько
  шаблонов; архивный шаблон не даёт черновика; период вне окна — 400.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md`, `docs/37-accounting.md` §8.

## Критерии приёмки

- [ ] Шаблоны заводятся и архивируются с аудитом.
- [ ] «Расходы месяца» создаёт черновики только нужных шаблонов и не
      дублирует их при повторе.
- [ ] Шаблон ничего не проводит сам.
- [ ] Миграция только расширяет схему; тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(finance): Шаблоны повторяющихся расходов`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ШАБЛОНЫ ПОВТОРЯЮЩИХСЯ РАСХОДОВ**

  Сервер, CDN, ИИ-инструменты и домены можно завести шаблонами (Р220):
  «Расходы месяца» создаёт черновики операций, их сверяют с фактом и
  проводят.

  🛠 **Что внутри**

  • график — каждый месяц или месяц года
  • повтор действия не плодит дублей
  • шаблон сам ничего не проводит
  ```
