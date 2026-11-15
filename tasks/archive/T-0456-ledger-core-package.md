---
id: T-0456
title: Ядро учёта packages/ledger — счета, проводки, сторно, остатки
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/ledger/**
shared:
  - scripts/test/layer-boundaries.test.ts
  - tsconfig.json
  - vitest.config.ts
  - pnpm-lock.yaml
  - docs/37-accounting.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 4
---

# T-0456. Ядро учёта packages/ledger — счета, проводки, сторно, остатки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0456.json)](../README.md#значки-статуса)

## Зачем

Модель учёта согласована (`docs/37-accounting.md`, Р219), а кода нет. Задача
заводит чистое ядро учёта — пакет без монорепо, Nest и Prisma, как ядро курсов
(`packages/fx`): двойная запись в целых минимальных единицах валюты, проверка
баланса, сторно, остатки. Журнал в базе (T-0457) и проводки из платежей
(T-0458) строятся на нём, и его можно взять в другой проект.

## Решения

- `docs/35-stage4-plan.md`, **Р98**, **Р219**; `docs/37-accounting.md` §2–§3,
  §11 (волна 2).
- Ядро **ничего не импортирует из монорепо, Nest и Prisma** — правило слоёв
  (`CLAUDE.md`, «Границы слоёв»): `packages/ledger` — в том же ряду, что
  `fx`, `proxy-kit`, `promo-kit`. Валюты ядро не знает само: справочник
  `{ code, decimals }` передаёт вызывающий.
- **Знак строки**: дебет — плюс, кредит — минус; **в каждой валюте сумма строк
  проводки — ноль**. Остаток счёта в отчёте — по его «нормальной стороне»:
  актив и расход — сумма строк, выручка, обязательство и капитал — сумма со
  знаком минус. Тогда пример `docs/37` §4 «оплата набора за 50 ⭐» —
  «Звёзды бота — в холде» `+50`, «Выручка: магазин, Telegram» `−50`, а
  отчёт покажет обе как `50`.
- **Суммы — `bigint`** в минимальных единицах (звёзды — штуки, Gram — нано,
  рубль — копейки); дробных чисел в ядре нет.
- Счёт — **одна валюта**; проводка может затрагивать несколько валют (обмен),
  баланс проверяется в каждой отдельно.
- Проводки не правятся — исправление **сторно**: проводка с обратными
  знаками и ссылкой на исходную.

## Как сейчас

- `packages/ledger` нет. Образец пакета — `packages/fx`: `package.json`
  (`"name": "@bh/fx"`, `"type": "module"`, `exports` с `source`/`types`/`default`,
  скрипты `build`/`typecheck`, точные версии зависимостей), `tsconfig.json`,
  `test/`.
- Правило слоёв — `scripts/test/layer-boundaries.test.ts`, записи для
  `packages/fx/src`, `packages/proxy-kit/src` (строка ~69):
  `forbidden: /["']@bh\/|["']@nestjs\/|["']@prisma\/|generated\/prisma/`.
- Коды валют проекта — `packages/fx/src/currencies.ts`: `XTR` (0), `GRAM` (9),
  `USDT` (6), `USD` (2), `RUB` (2), `EUR` (2). Ядро учёта их не импортирует —
  бэкенд передаст справочник сам (T-0457).

## Шаги по порядку

1. **Пакет** `packages/ledger`: `package.json` по образцу `fx`
   (`"name": "@bh/ledger"`, без зависимостей, кроме `@types/node` в dev),
   `tsconfig.json`; ссылка в корневом `tsconfig.json` (`references`, как
   `{ "path": "packages/fx" }`) и псевдоним `"@bh/ledger"` в `vitest.config.ts`
   (как `"@bh/fx"`, строка ~37). `pnpm install` — обновить `pnpm-lock.yaml`.
2. **Валюта** `src/money.ts`:
   - `interface CurrencySpec { code: string; decimals: number }` (0…18);
   - `toMinor(value: string, spec): bigint` — десятичная строка
     («12.34», «−0.5», «100») в минимальные единицы; больше знаков, чем
     `decimals`, — исключение (не округлять молча);
   - `formatMinor(amount: bigint, spec): string` — обратно, без потери
     точности («1234» и 2 знака → «12.34»; «−5» и 9 знаков → «−0.000000005»).
3. **Счета** `src/accounts.ts`:

   ```ts
   export type AccountType = "asset" | "revenue" | "expense" | "liability" | "equity";
   export interface LedgerAccount {
     id: string;          // устойчивый ключ, «stars.bot.hold»
     type: AccountType;
     currency: string;    // код из справочника
     name: string;        // для панели
   }
   /** Знак нормальной стороны: актив и расход +1, остальные −1. */
   export function normalSign(type: AccountType): 1n | -1n;
   ```

4. **Проводки** `src/entries.ts`:

   ```ts
   export interface EntryLine { accountId: string; amount: bigint } // дебет +, кредит −
   export interface EntryDraft {
     sourceKey: string;   // ключ идемпотентности: «purchase:<id>:paid»
     at: Date;            // когда случилось — по нему период
     memo: string;
     lines: EntryLine[];
     reversalOf?: string; // sourceKey исходной, если это сторно
   }
   export type EntryProblem =
     | { kind: "empty_source_key" } | { kind: "too_few_lines" }
     | { kind: "zero_line"; accountId: string } | { kind: "unknown_account"; accountId: string }
     | { kind: "duplicate_account"; accountId: string }
     | { kind: "unbalanced"; currency: string; sum: bigint };
   export function findEntryProblems(draft: EntryDraft, accounts: ReadonlyMap<string, LedgerAccount>): EntryProblem[];
   export function reverse(original: EntryDraft, sourceKey: string, at: Date, memo: string): EntryDraft;
   export function periodOf(at: Date): string; // «YYYY-MM» по UTC
   ```

   Правила `findEntryProblems`: `sourceKey` не пустой и не длиннее 128;
   строк не меньше двух; сумма строки не ноль; счёт известен; один счёт —
   одна строка в проводке (две строки на один счёт — `duplicate_account`,
   их нужно сложить); в каждой валюте сумма — ноль. `reverse` меняет знак
   каждой строки и ставит `reversalOf`; сторно сторно — обычная проводка,
   отдельного запрета нет.
5. **Остатки** `src/balances.ts`:
   `balances(lines: Iterable<EntryLine>, accounts): Map<string, bigint>` —
   сумма по счёту со знаком нормальной стороны; счёт без строк — `0n`.
   `trialBalance(...)` — суммы по валютам: в каждой должен быть ноль
   (проверка целостности журнала, а не отчёт).
6. `src/index.ts` — экспорт всего выше.
7. **Правило слоёв** — запись в `layer-boundaries.test.ts`:
   `from: "packages/ledger/src"`, тот же запрет, что у `fx`, `why`: «ядро учёта
   переходит в другие проекты: ни игры, ни Nest, ни Prisma
   (docs/35-stage4-plan.md, Р98, Р219)».
8. **Документы**: `docs/37-accounting.md` §2 — абзац про знак строки и
   нормальную сторону (это уточнение модели, а не новая идея: пример §4
   переписать знаками `+50` / `−50`); `docs/21-diagrams.md` — пакет на
   схеме связей пакетов, если она там есть.

## Чего не трогаем

- База, Nest, панель — T-0457, T-0458, T-0459.
- `packages/fx` — ядро учёта его не импортирует.
- Курсы и пересчёт в отчётную валюту — отчёт волны 4.

## Сценарий и интерфейс

```ts
const accounts = new Map([
  ["stars.bot.hold", { id: "stars.bot.hold", type: "asset", currency: "XTR", name: "Звёзды бота — в холде" }],
  ["revenue.shop.telegram", { id: "revenue.shop.telegram", type: "revenue", currency: "XTR", name: "Выручка: магазин, Telegram" }],
]);
findEntryProblems({ sourceKey: "purchase:1:paid", at, memo: "", lines: [
  { accountId: "stars.bot.hold", amount: 50n }, { accountId: "revenue.shop.telegram", amount: -50n },
] }, accounts); // []
```

## Тесты

Первым коммитом, `packages/ledger/test/`:

- `money.test.ts`: `toMinor("12.34", 2) = 1234n`, `toMinor("1", 9) = 1000000000n`,
  `toMinor("0.1234", 2)` — исключение, `toMinor("abc")` — исключение;
  `formatMinor` обратно для 0, отрицательных, 18 знаков; круговое
  преобразование на наборе значений.
- `entries.test.ts`: оплата 50 ⭐ — без проблем; одна строка —
  `too_few_lines`; строка с нулём; неизвестный счёт; две строки одного
  счёта — `duplicate_account`; обмен в двух валютах (XTR и GRAM), каждая
  сходится — без проблем; одна валюта не сходится — `unbalanced` с суммой;
  `reverse` — знаки обратные, `reversalOf` стоит, проверка проходит;
  `periodOf` — 31.10 23:59:59.999 UTC → «2026-10», 01.11 00:00 → «2026-11».
- `balances.test.ts`: актив и выручка после оплаты — оба `50n`; после сторно
  — нули; `trialBalance` журнала из нескольких проводок — ноль в каждой
  валюте.
- `scripts/test/layer-boundaries.test.ts` — запись для `packages/ledger/src`
  (импорт `@bh/fx` из ядра учёта ловится).

## Аналитика

Нет: ядро без ввода-вывода.

## Настройки и окружение

Нет.

## Документы

- `docs/37-accounting.md` §2 и §4 (шаг 8); `docs/21-diagrams.md` (шаг 8).

## Критерии приёмки

- [ ] Пакет `@bh/ledger` собирается, не импортирует монорепо, Nest и Prisma —
      это проверяет тест слоёв.
- [ ] Несбалансированная в любой валюте проводка, нулевая строка, неизвестный
      счёт и повтор счёта находятся `findEntryProblems`.
- [ ] Суммы — только `bigint`; преобразование строк без потери точности.
- [ ] Тесты из раздела «Тесты» есть и зелёные; гейт и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(ledger): Ядро учёта — счета, проводки, сторно`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЯДРО УЧЁТА PACKAGES/LEDGER**

  Вторая волна бухгалтерии началась (Р219): чистое ядро учёта — двойная
  запись в целых минимальных единицах валюты, проверка баланса, сторно,
  остатки. Без игры, Nest и Prisma — его можно взять в другой проект.

  🛠 **Что внутри**

  • дебет +, кредит −, в каждой валюте сумма строк — ноль
  • остаток по нормальной стороне: актив и расход плюсом, выручка и долги — тоже плюсом
  • журнал в базе — T-0457, проводки из платежей — T-0458
  ```
