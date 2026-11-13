---
id: T-0466
title: Водопад месяца в ядре учёта и месяц проводки «за какой месяц»
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: S
depends_on: [T-0456]
zones:
  - packages/ledger/src/waterfall.ts
  - packages/ledger/src/entries.ts
  - packages/ledger/src/index.ts
  - packages/ledger/test/waterfall.test.ts
  - packages/ledger/test/entries.test.ts
shared:
  - docs/37-accounting.md
  - backend/api/src/modules/ledger/ledger-problems.ts
  - backend/api/test/ledger-journal.test.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0466. Водопад месяца в ядре учёта и месяц проводки «за какой месяц»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0466.json)](README.md#значки-статуса) [![T-0456](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0456.json&label=T-0456)](T-0456-ledger-core-package.md)

## Зачем

Закрытие месяца (Р222) считает раздел прибыли по формуле
`docs/11-revenue-split.md` §3: выручка → расходы → налог → транш займа →
прибыль к разделу → доли. Формула — чистая арифметика с деньгами, её место —
в ядре учёта рядом с проводками, с тестами на краевые случаи (ноль, убыток,
займ больше прибыли, доли до 100 %). Заодно проводке нужен месяц, отличный от
даты: расход «за ноябрь», оплаченный 2 декабря.

## Решения

- `docs/35-stage4-plan.md`, **Р222**, **Р221**, **Р217**;
  `docs/11-revenue-split.md` §3; `docs/37-accounting.md` §13.
- Водопад считается **в минимальных единицах одной валюты отчёта** (центы
  доллара) — вход уже пересчитан вызывающим по курсу дня каждой проводки.
- Налог — **вход** (сумма уже посчитана с чеков в рублях и переведена
  вызывающим, Р221), ядро ставок НПД не знает.
- Округление: транш займа и доли — **вниз** до цента, остаток (копейки от
  округления) — владельцу; сумма выходов равна прибыли к разделу точно.
- Прибыль к разделу ≤ 0 — траншей и выплат нет, всё нули, признак
  `noDistribution`.

## Как сейчас

- `@bh/ledger` (T-0456): `EntryDraft { sourceKey, at, memo, lines, reversalOf? }`,
  `periodOf(at)`.

## Шаги по порядку

1. `src/entries.ts`: у `EntryDraft` — необязательное `period?: string`
   («YYYY-MM»); `periodOfEntry(draft)` — `period` или `periodOf(at)`;
   `findEntryProblems` — новая проблема `bad_period` (не «YYYY-MM» или
   позже месяца `at`: расход «за будущий месяц» запрещён).
2. `src/waterfall.ts`:

   ```ts
   export interface WaterfallInput {
     revenue: { key: string; amount: bigint }[];   // по площадкам и источникам
     otherIncome: { key: string; amount: bigint }[];
     expenses: { key: string; amount: bigint }[];  // построчно, включая начисления партнёрам
     tax: bigint;                                   // налог периода в валюте отчёта
     loans: { loanId: string; remaining: bigint; repaymentBp: number }[];
     shares: { accountId: string; bp: number }[];   // доли участников месяца, Σ ≤ 10 000
   }
   export interface WaterfallResult {
     grossRevenue: bigint; totalExpenses: bigint;
     profitBeforeTax: bigint; tax: bigint; netProfit: bigint;
     tranches: { loanId: string; amount: bigint; remainingAfter: bigint }[];
     toDistribute: bigint;
     payouts: { accountId: string; bp: number; amount: bigint }[];
     ownerAmount: bigint;
     noDistribution: boolean;
   }
   export function computeWaterfall(input: WaterfallInput): WaterfallResult;
   ```

   Порядок — строго `docs/11` §3: `profitBeforeTax = выручка + прочие − расходы`;
   `netProfit = profitBeforeTax − tax`; транши по займам по очереди входа,
   каждый `min(remaining, floor(netProfit × bp / 10000))`, общий итог
   траншей не больше `netProfit`; `toDistribute = netProfit − Σ траншей`;
   выплаты — `floor(toDistribute × bp / 10000)`; `ownerAmount` — остаток.
   Отрицательные входы, `bp` вне 0…10 000, Σ долей > 10 000 — исключение.
3. Экспорт из `index.ts`; `docs/37-accounting.md` §13 — ссылка на
   `computeWaterfall` и правило округления.

## Чего не трогаем

- Бэкенд, периоды, курсы — T-0467, T-0468.

## Сценарий и интерфейс

- Выручка 1 000,00 $, расходы 200,00 $, налог 32,00 $, займ 500,00 $ под
  25 %: прибыль до налога 800,00; чистая 768,00; транш 192,00; к разделу
  576,00; участник 30 % — 172,80; владелец — 403,20.

## Тесты

Первым коммитом, `packages/ledger/test/waterfall.test.ts`:

- пример из «Сценария» — каждое поле;
- убыток и ноль — `noDistribution`, нули;
- транш больше остатка займа — равен остатку, `remainingAfter = 0`;
- два займа — по очереди, итог траншей не больше чистой прибыли;
- доли 33,33 % × 3 — выплаты вниз, остаток с копейками — владельцу,
  `Σ выплат + ownerAmount = toDistribute` точно;
- Σ долей > 100 % и отрицательный вход — исключение.

`entries.test.ts`: `period` раньше месяца `at` — без проблем; позже —
`bad_period`; «2026-13» — `bad_period`.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/37-accounting.md` §13.

## Критерии приёмки

- [x] Водопад считает строго по `docs/11` §3, без потери копеек: сумма
      выплат и доли владельца равна прибыли к разделу.
- [x] Убыток и ноль не дают выплат; займ не гасится больше остатка.
- [x] Проводка может нести месяц раньше своей даты, но не позже.
- [x] Тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(ledger): Водопад месяца и месяц проводки`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВОДОПАД МЕСЯЦА В ЯДРЕ УЧЁТА**

  Ядро учёта считает раздел прибыли месяца по docs/11 §3 (Р222): выручка,
  расходы, налог, транш займа, доли участников и остаток владельца — без
  потери копеек.

  🛠 **Что внутри**

  • убыток и ноль — выплат нет
  • доли и транш — вниз до цента, копейки остатка — владельцу
  • проводка может быть «за прошлый месяц», но не за будущий
  ```
