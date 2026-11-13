---
id: T-0468
title: Месяцы учёта — сверка с блокерами, закрытие с водопадом, снятие закрытия
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0466, T-0467, T-0461, T-0452]
zones:
  - backend/api/src/modules/ledger/periods/**
  - backend/api/test/ledger-periods.test.ts
  - backend/api/test/ledger-periods.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/modules/ledger/ledger.service.ts
  - backend/api/src/modules/ledger/operations/operations.service.ts
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/test/admin-ledger.http.test.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/route-permissions.test.ts
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0468. Месяцы учёта — сверка с блокерами, закрытие с водопадом, снятие закрытия

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0468.json)](README.md#значки-статуса) [![T-0466](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0466.json&label=T-0466)](T-0466-ledger-waterfall-core.md) [![T-0467](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0467.json&label=T-0467)](T-0467-fx-rate-at-date.md) [![T-0461](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0461.json&label=T-0461)](T-0461-ledger-manual-operations.md) [![T-0452](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0452.json&label=T-0452)](T-0452-stakeholder-shares-server.md)

## Зачем

Учёт пишет проводки, но месяц нигде не закрывается: нет ни налога, ни
раздела прибыли, ни долгов участникам. Задача заводит месяцы учёта со
статусами «открыт → на сверке → закрыт» (Р222): сверка показывает, что мешает
закрыть, закрытие считает водопад по курсу дня каждой проводки, проводит
начисление налога и долги участникам в рублях и запирает месяц, а снять
закрытие можно, пока никому не выплачено.

## Решения

- `docs/35-stage4-plan.md`, **Р222**, **Р221**, **Р217**;
  `docs/37-accounting.md` §12, §13; `docs/11-revenue-split.md` §3–§5.
- Сверку запускает и закрывает только владелец — право `finance.period.close`
  (уже есть, только у владельца).
- **Блокеры** (закрыть нельзя): операции месяца в `pending` и `draft`;
  живые оплаты месяца без проводки оплаты (сверка платежей отстала); у
  проводки месяца нет курса на дату (`rateAt` → `null`). **Предупреждения**
  (закрыть можно): рублёвые поступления без чека (Р221), курс `stale`,
  сумма чеков года ≥ порога лимита НПД.
- **Налог** = Σ по чекам месяца: сумма поступления в рублях × ставка
  плательщика (физлицо — `finance.npd-rate-individual-bp`, 400; юрлицо —
  `finance.npd-rate-legal-bp`, 600); в долларах для водопада — по курсу рубля
  дня закрытия.
- **Займы** — остаток (`ledger_loan`, тело + премия − погашенное) и ставка
  погашения на дату закрытия.
- **Доли** — `stakeholder_share` на месяц (T-0452).
- **Закрытие** проводит (ключи `close:<месяц>:r<N>:…`, где `N` — сколько
  раз месяц уже открывали заново: повторное закрытие после снятия не
  конфликтует со сторнированными ключами; дата — день закрытия, месяц —
  закрываемый):
  - `close:<м>:r<N>:tax` — `expense.tax_accrued.RUB +налог`, `liability.tax.RUB −налог`;
  - `close:<м>:r<N>:payout:<аккаунт>` — `equity.distribution.RUB +сумма`,
    `liability.stakeholder.<аккаунт>.RUB −сумма` (выплата участника из
    водопада, в рублях по курсу дня закрытия, вниз до копейки);
  доля владельца долгом не проводится (Р222: забирается выплатой по
  желанию). Счета `liability.*`, `equity.*` создаются при первой проводке.
- **Снимок** параметров и результата — в строке месяца: ставки НПД, доли,
  займы, курсы по дням, весь `WaterfallResult` и рублёвые суммы.
- **Снятие закрытия**: только если по месяцу не было ни одной выплаты
  (T-0469); сторно всех проводок закрытия этого раза, `reopened_count + 1`, статус «на сверке», причина
  обязательна; сброс подтверждений — T-0469.
- **Замок**: проводка с месяцем закрытого периода — 409 `ledger_period_closed`
  (кроме сторно закрытия); операции «за какой месяц» — только в открытый
  месяц.

## Как сейчас

- Водопад — `computeWaterfall` (T-0466), курс на дату — `FxService.ratesAt`
  (T-0467), операции и займы — T-0461, доли — T-0452, проводки из платежей —
  T-0458, `LedgerService.post` (T-0457).
- Настройки — `setting-catalog.ts` (`integer(...)`).

## Шаги по порядку

1. **Схема и миграция** `<время>_ledger_periods`: `ledger_period` —
   `period char(7) pk`, `status` (`open`, `review`, `closed`), `review_at/by`,
   `closed_at/by`, `reopened_count int default 0`, `snapshot jsonb null`,
   `updated_at`. Месяц без строки — «открыт».
2. **Настройки**: `finance.npd-rate-individual-bp` (400), `finance.npd-rate-legal-bp`
   (600), `finance.npd-year-limit-rub` (2 400 000), `finance.npd-warn-percent`
   (80) — группа «Бухгалтерия» (или «Платежи»), строки в
   `docs/30-configuration-map.md`.
3. **Сбор месяца** `periods/period-facts.ts` (репозиторий + чистые функции):
   проводки месяца по счетам, оценённые в центах по `ratesAt`; выручка по
   площадкам и источникам (счета `revenue.*`), прочие поступления
   (`income.*`), расходы (`expense.*`, кроме `expense.tax_accrued`), чеки
   месяца (из операций с `receipt`), займы, доли.
4. **Чек-лист** `periods/checklist.ts`: блокеры и предупреждения из
   «Решений» — каждый пункт с числом и ссылкой (id операций, покупок, дат
   без курса).
5. **Сервис** `periods/periods.service.ts`:
   - `startReview(owner, period)` — только прошлый или раньше, статус
     `open` → `review`; аудит;
   - `preview(period)` — чек-лист и черновик водопада (без записи);
   - `close(owner, period)` — блокеров нет; в одной транзакции: снимок,
     проводки закрытия, `closed`; аудит `ledger.period.close`;
   - `reopen(owner, period, reason)` — проверка «выплат не было» через
     хук T-0469 (пока — всегда разрешено), сторно, `review`, аудит;
   - замок в `LedgerService.post`: месяц проводки закрыт → 409.
6. **Маршруты**: `GET /periods` (список месяцев со статусами),
   `GET /periods/:p` (чек-лист, отчёт), `POST /periods/:p/review`,
   `POST /periods/:p/close`, `POST /periods/:p/reopen` — право
   `finance.period.close`; чтение — `ledger.view`.
7. **Документы**: ER (`ledger_period`); `docs/37-accounting.md` §13 —
   ключи проводок закрытия и снимок.

## Чего не трогаем

- Подтверждения, выплаты, сообщения участникам — T-0469.
- Экраны — T-0470, T-0471.
- Ядро водопада — T-0466 (только вызвать).

## Сценарий и интерфейс

- 2 декабря владелец ставит ноябрь «на сверку»: блокер «1 операция ждёт
  подтверждения» → подтверждает → блокеров нет, предупреждение «2 рублёвых
  поступления без чека» → закрывает: налог 2 944 ₽, участнику 15 980,40 ₽.
- Участник оспорил — владелец снимает закрытие с причиной: проводки
  закрытия сторнированы, месяц снова «на сверке».

## Тесты

Первым коммитом:

- `backend/api/test/ledger-periods.test.ts`: чек-лист — каждый блокер и
  предупреждение по отдельности; налог по чекам двух ставок; оценка проводок
  по курсам разных дней; водопад и рублёвые долги из него (вниз до копейки);
  снимок содержит всё для пересчёта без базы.
- `backend/api/test/ledger-periods.integration.test.ts` (Postgres): закрытие
  пишет `close:<м>:r0:tax` и долги; проводка в закрытый месяц — 409; два
  одновременных `close` — одно закрытие; `reopen` — сторно всех проводок
  закрытия; повторное закрытие пишет `close:<м>:r1:*` без конфликта с
  первым разом.
- `backend/api/test/admin-ledger.http.test.ts`: финансы на `close` — 403.

## Аналитика

Нет продуктовых событий; след — аудит и проводки.

## Настройки и окружение

- Четыре ключа НПД (шаг 2) — `docs/30-configuration-map.md`.

## Документы

- `docs/21-diagrams.md`, `docs/30-configuration-map.md`, `docs/37-accounting.md` §13.

## Критерии приёмки

- [ ] Месяц ставится на сверку, чек-лист показывает блокеры и
      предупреждения со ссылками; с блокерами месяц не закрывается.
- [ ] Закрытие оценивает проводки по курсу их дня, считает налог с чеков и
      водопад, проводит налог и долги участникам в рублях, хранит снимок.
- [ ] В закрытый месяц ничего не проводится; снятие закрытия сторнирует
      проводки закрытия.
- [ ] Миграция только расширяет схему; тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(finance): Закрытие месяца учёта`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАКРЫТИЕ МЕСЯЦА УЧЁТА**

  Месяц учёта закрывается по правилам Р222: сверка с блокерами, водопад
  по курсу дня каждой проводки, налог НПД с чеков, долги участникам в
  рублях.

  🛠 **Что внутри**

  • закрывает только владелец; блокеры — операции на подтверждении, непроведённые оплаты, нет курса
  • в закрытый месяц ничего не пишется; снять закрытие можно, пока не выплачено
  • снимок параметров: смена ставок и долей потом прошлое не трогает
  ```
