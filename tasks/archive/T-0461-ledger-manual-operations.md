---
id: T-0461
title: Ручные операции учёта — перевод, обмен, расход, поступление, заём, исправление (сервер)
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0460, T-0453]
zones:
  - backend/api/src/modules/ledger/operations/**
  - backend/api/prisma/migrations/
  - backend/api/test/ledger-operations.test.ts
  - backend/api/test/ledger-operations.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/test/admin-ledger.http.test.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/route-permissions.test.ts
  - docs/21-diagrams.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0461. Ручные операции учёта — перевод, обмен, расход, поступление, заём, исправление (сервер)

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0461.json)](../README.md#значки-статуса) [![T-0460](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0460.json&label=T-0460)](T-0460-ledger-places-and-articles.md) [![T-0453](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0453.json&label=T-0453)](T-0453-my-project-revenue-server.md)

## Зачем

Проводки из платежей учёт делает сам (T-0458), но выводы, обмены, расходы
на сервер и CDN, выплаты рекламных сетей и займы вносит человек (Р220).
Задача даёт серверу операции: человек описывает, что случилось, понятными
полями, а сервер сам собирает из этого проводку двойной записи, проверяет её
и пишет в журнал. Второй ключ и картинка чека — T-0462, шаблоны — T-0463.

## Решения

- `docs/35-stage4-plan.md`, **Р220**, **Р221**; `docs/37-accounting.md` §4,
  §6, §12.
- Вносят владелец и финансы — право `finance.entry.create`.
- Операция хранит **что ввёл человек** (виды ниже) и **ключ проводки**,
  которую из неё собрал сервер (`op:<id>`). Статусы: `draft` (черновик, в
  т. ч. из шаблона), `pending` (ждёт второго ключа, T-0462), `posted`,
  `rejected`. В этой задаче `submit` проводит сразу (`draft` → `posted`);
  T-0462 вставит проверку порога между ними.
- **Виды** (поля — суммы десятичными строками в валюте места):
  - `transfer` — с места A на место B той же валюты: сумма, комиссия
    (по шаблону места A, правится), дата;
  - `exchange` — с места A (валюта X) на место B (валюта Y): отдано,
    получено — **обе суммы фактические**, курс = получено / отдано пишется в
    `meta`; комиссия по шаблону места A; разница с курсом ядра курсов —
    волна 4 («Курсовая разница»);
  - `expense` — с места, статья расхода, сумма;
  - `income` — на место, статья поступления (выплата рекламной сети, прочее),
    сумма, **за какой месяц** (О51: выручка сети — её месяца);
  - `loan` — на место, кредитор (имя), сумма, условия: премия (сумма),
    ставка погашения (процент чистой прибыли); заводит счёт-обязательство
    «Заём: <кредитор>» и запись займа;
  - `reversal` — исправление: ключ исходной проводки и причина; сторно через
    `LedgerService.reverse`.
- **Чек НПД** (Р221): у `exchange` и `income`, если место назначения в
  рублях, — необязательное `receipt { number?, link?, payer: "individual" | "legal" }`;
  без чека операция проводится, но в ответе — признак `receiptMissing`.
- У всех видов: `note` — причина/описание (обязательно, 3…500), `link` —
  ссылка (необязательно, `https://`), `at` — дата события (не будущее, не
  раньше 2026-01-01).

## Как сейчас

- `LedgerService.post`/`reverse` (T-0457), места, статьи,
  `ensureArticleAccount`, `feeOf` (T-0460).
- Справочник валют — `CURRENCIES` из `@bh/fx`; `toMinor` из `@bh/ledger`.

## Шаги по порядку

1. **Схема и миграция** `<время>_ledger_operations`:
   - `ledger_operation`: `operation_id uuid pk`, `kind` (enum шести видов),
     `status` (`draft`, `pending`, `posted`, `rejected`), `input jsonb`
     (поля вида), `note varchar(500)`, `link varchar(500) null`,
     `amount_usd numeric(18,2) null` (оценка для порога и списка),
     `source_key varchar(128) null unique` (ключ проводки после проводки),
     `created_by uuid`, `created_at`, `decided_by uuid null`,
     `decided_at null`, `decision_note varchar(500) null`,
     `template_id varchar(64) null`, `template_period char(7) null`,
     `@@unique([template_id, template_period])`, индекс `(status, created_at)`;
   - `ledger_loan`: `loan_id uuid pk`, `lender varchar(128)`,
     `account_id` (счёт-обязательство), `currency`, `principal bigint`,
     `premium bigint`, `repayment_bp int` (0…10 000), `operation_id`,
     `created_at`.
2. **Чистые сборщики** `operations/builders.ts`: для каждого вида —
   `build(input, chart, specs): EntryDraft | BuildProblem[]`. Строки:
   - перевод: `A −(сумма+комиссия в валюте A)`, `B +сумма`,
     `expense.fee_withdrawal.<валюта A> +комиссия`; фикса в другой валюте —
     пара строк в этой валюте: место A этой валюты, если оно есть, иначе
     проблема «нет места в валюте фиксы»;
   - обмен: `A −отдано`, `B +получено`, комиссия как у перевода (статья
     `fee_exchange`); валюты разные — баланс сходится в каждой через
     служебный счёт-актив обмена `exchange.transit.<валюта>` (по `docs/37`
     §4: «Обмен» — две строки на валюту);
   - расход: `место −сумма`, `expense.<статья>.<валюта> +сумма`;
   - поступление: `место +сумма`, `income.<статья>.<валюта> −сумма`,
     `meta.forMonth`;
   - заём: `место +сумма`, `loan.<slug кредитора>.<валюта> −сумма`.
   Сборщик ничего не пишет; проблемы — `BuildProblem` с русским текстом.
3. **Сервис** `operations/operations.service.ts`:
   - `create(actor, input)` → `draft` (проверка полей, оценка `amount_usd`
     через `FxService.peek` — не нашёлся курс — `null`);
   - `update(actor, id, input)` — только `draft`, только автор или владелец;
   - `submit(actor, id)` — сборка → `LedgerService.post` с
     `sourceKey: "op:<id>"`, `createdBy` → `posted`; для `loan` — в той же
     транзакции строка `ledger_loan`. Ошибка сборки — 400
     `ledger_operation_invalid` с текстом проблемы;
   - `discard(actor, id)` — только `draft`;
   - `list(filter, cursor)` и `get(id)` — с проводкой и признаком
     `receiptMissing`;
   - аудит: `ledger.operation.create|submit|discard`.
4. **Маршруты** `admin-ledger.controller.ts`, право `finance.entry.create`
   (список — `ledger.view`): `GET /operations`, `GET /operations/:id`,
   `POST /operations`, `PATCH /operations/:id`, `POST /operations/:id/submit`,
   `POST /operations/:id/discard`. Тело — дискриминированное объединение
   Zod по `kind`, `.strict()`.
5. **Документы**: `docs/21-diagrams.md` — ER (`ledger_operation`,
   `ledger_loan`); `docs/37-accounting.md` §4, §6 — как операции
   превращаются в проводки (таблица строк по видам).

## Чего не трогаем

- Второй ключ, уведомление, картинка чека — T-0462.
- Шаблоны — T-0463. Экраны — T-0464.
- Транш займа, налог, курсовая разница — волна 4.
- Проводки из платежей (T-0458).

## Сценарий и интерфейс

- Вывод 10 000 ⭐ через Fragment: `exchange` со `stars.bot.available`
  10 000 на `wallet.ton` 52,3 Gram, комиссия по шаблону → проводка в двух
  валютах, курс в `meta`.
- Оплата сервера 1 500 ₽ с `bank.rub`: `expense`, статья `vps` →
  `bank.rub −1500.00`, `expense.vps.RUB +1500.00`.

## Тесты

Первым коммитом:

- `backend/api/test/ledger-operations.test.ts` (сборщики): каждый вид —
  проводка проходит `findEntryProblems`; перевод с процентом и фиксой в
  другой валюте; обмен XTR→GRAM сходится в обеих валютах, курс в `meta`;
  нет места в валюте фиксы — проблема; сумма с лишними знаками — проблема;
  дата в будущем — проблема; `receiptMissing` у поступления в рубли без чека.
- `backend/api/test/ledger-operations.integration.test.ts` (Postgres): черновик
  → проводка, остатки мест изменились; повторный `submit` — та же проводка
  (идемпотентно по `op:<id>`); правка проведённой — 409; заём создаёт
  счёт-обязательство и `ledger_loan`; исправление — сторно исходной.
- `backend/api/test/admin-ledger.http.test.ts`: участник проекта — 403 на
  `POST /operations`; финансы — 200; лишнее поле — 400.

## Аналитика

Нет: операции команды, след — аудит и журнал.

## Настройки и окружение

Нет (порог второго ключа — T-0462).

## Документы

- `docs/21-diagrams.md`, `docs/37-accounting.md` §4, §6 (шаг 5).

## Критерии приёмки

- [ ] Шесть видов операций собираются в проводки двойной записи, которые
      проходят проверку ядра; обмен сходится в каждой валюте.
- [ ] Черновик правится, проведённая операция — нет; исправление — сторно.
- [ ] Заём заводит обязательство и условия для волны 4.
- [ ] Поступление в рубли несёт чек НПД или признак его отсутствия.
- [ ] Миграция только расширяет схему; ER обновлена; тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(finance): Ручные операции учёта`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РУЧНЫЕ ОПЕРАЦИИ УЧЁТА**

  Финансы и владелец вносят операции понятными полями, а сервер сам
  собирает проводку двойной записи (Р220): перевод, обмен, расход,
  поступление, заём и исправление.

  🛠 **Что внутри**

  • обмен — обе фактические суммы, курс считается сам
  • комиссия — по шаблону места, правится на месте
  • поступление в рубли несёт чек НПД — из него волна 4 посчитает налог (Р221)
  ```
