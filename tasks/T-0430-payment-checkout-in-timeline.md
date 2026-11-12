---
id: T-0430
title: Предварительная проверка оплаты в хронологии платежа
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0429]
zones:
  - backend/api/src/modules/payments/payment-checkout-marks.ts
  - backend/api/src/modules/payments/payment-confirmation.ts
  - backend/api/test/payment-checkout-marks.test.ts
  - backend/api/test/payment-confirmation.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/payments/payments.module.ts
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0430. Предварительная проверка оплаты в хронологии платежа

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0430.json)](README.md#значки-статуса) [![T-0429](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0429.json&label=T-0429)](T-0429-payments-feed-server.md)

## Зачем

Игрок пишет «не смог оплатить», а в базе — только счёт: ответ на
предварительную проверку (`pre_checkout_query`) пишется лишь в лог сервера.
После задачи покупка помнит последнюю проверку — когда и с каким ответом, — и
карточка платежа (T-0429) показывает её строкой хронологии: «пройдена» или
«отказ — счёт устарел».

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`): хронология платежа включает
  `pre_checkout`.
- **Решение тимлида claude-lead-1, 11.11.2026:** хранится **последняя**
  проверка покупки — две колонки `purchase`, а не журнал: повторных проверок
  у одной покупки единицы, а журнал ради них — лишняя таблица. Продление
  подписки проверяется по счёту первой покупки и перезаписывает её отметку —
  это честно: «последняя проверка по этому счёту».
- **Ответ площадке — первым.** Отметка пишется **после** `answerCheckout` и не
  ждётся: у Telegram на весь ответ 10 секунд, отметка не должна их съедать.
  Запись — с таймаутом 2 с, сбой — строка `warn` в лог, не ошибка.
- **Payload не UUID или покупки нет** — отметки нет: писать некуда.
- **Хронология** — источник реестра `PaymentFeedSources` (T-0429), а не правка
  ленты: строка вида `checkout`.

## Как сейчас

- `backend/api/src/modules/payments/payment-confirmation.ts:73–90` —
  `answerCheckout`: решение `decide`, ответ `provider.answerCheckout`, строка
  лога `pre_checkout` с `ok` и `reason`. Конструктор — с необязательными
  параметрами в конце (`hooks`, `revocation`, `restrictions`, `system`).
- `backend/api/src/modules/payments/checkout-answer.ts` — `CheckoutRefusal`:
  `disabled`, `unknown_invoice`, `foreign_user`, `purchases_closed`,
  `already_paid`, `subscription_active`, `price_mismatch`, `stale_invoice`,
  `run_finished`, `continue_taken`, `unavailable`.
- `backend/api/prisma/schema.prisma:613` — `model Purchase`, после
  `invoicedAt` (строка ~636).
- После T-0429: `payment-feed-sources.ts` — `PaymentFeedSources.register`,
  `payment-timeline.ts` — `TimelineEntry`, вид `checkout`.
- `purchases.repository.ts` — больше 470 строк, новых методов туда не
  добавлять.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция.** В `model Purchase` после `invoicedAt`:

   ```prisma
   /// последняя предварительная проверка оплаты по этому счёту (Р209); у продления — отметка первой покупки
   checkoutAt        DateTime?       @map("checkout_at") @db.Timestamptz(3)
   /// отказ последней проверки (`CheckoutRefusal`); `null` — пройдена или не было
   checkoutRefusal   String?         @map("checkout_refusal") @db.VarChar(32)
   ```

   Миграция — по строке «миграции» раздела «Общие файлы» `tasks/README.md`,
   имя `…_purchase_checkout_mark`; только `ADD COLUMN … NULL`. `SELECT` в
   `purchases.repository.ts` и `StoredPurchase` **не трогать**: новые колонки
   читает только источник.
3. **`payment-checkout-marks.ts`** — `PaymentCheckoutMarks` (`@Injectable()`,
   `OnModuleInit`; зависимости — `PRISMA`, `PaymentFeedSources`):

   ```ts
   /** Записать последнюю проверку. Покупки нет — ничего, не ошибка. */
   mark(purchaseId: string, at: Date, refusal: CheckoutRefusal | null): Promise<void>; // updateMany по purchaseId
   /** Последняя проверка; `null` — проверки не было. Строка из базы — через разбор, незнакомый отказ — как есть строкой. */
   of(purchaseId: string): Promise<{ at: Date; refusal: string | null } | null>;
   ```

   `onModuleInit` — `sources.register("checkout", …)`: `timeline` — одна строка
   вида `checkout` во время `checkoutAt`, `actorName: null`, текст дословно:
   «Предварительная проверка пройдена» или «Предварительная проверка: отказ —
   <подпись>»; подписи: `disabled` «оплата выключена», `unknown_invoice` «счёт
   не найден», `foreign_user` «платит другой игрок», `purchases_closed`
   «покупки аккаунту закрыты», `already_paid` «уже оплачено»,
   `subscription_active` «VIP уже действует», `price_mismatch` «сумма не
   совпала», `stale_invoice` «счёт устарел», `run_finished` «забег закончен»,
   `continue_taken` «продолжено за рекламу», `unavailable` «база не ответила»;
   незнакомый код — сам код. `marks` — пустая карта, `actions` — пусто.
4. **`payment-confirmation.ts`** — последним параметром конструктора
   `@Optional() private readonly checkoutMarks?: PaymentCheckoutMarks`. В
   `answerCheckout` после `provider.answerCheckout` и строки лога:
   `void this.recordCheckout(query.payload, decision, nowMs)`, где
   `recordCheckout` — `purchaseId.safeParse` (UUID), затем
   `withTimeout(this.checkoutMarks.mark(…), 2_000, "отметка проверки оплаты")`
   в `try`; ошибка — `log("warn", "checkout_mark_failed", { purchaseId, reason })`.
   Без `checkoutMarks` (тесты) — ничего.
5. **`payments.module.ts`** — `PaymentCheckoutMarks` в `providers`.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Решение проверки (`checkout-answer.ts`) и тексты отказов игроку.
- `purchases.repository.ts`, `StoredPurchase`, `SELECT` — новые колонки их не
  касаются, сравнения `toEqual` покупок в тестах не меняются.
- Ленту и карточку (T-0429) — только регистрация источника.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/payment-confirmation.test.ts`:
  - проверка прошла → `mark(purchaseId, время, null)` вызван **после**
    `provider.answerCheckout` (порядок вызовов в подставном провайдере);
  - отказ `stale_invoice` → `mark(…, "stale_invoice")`;
  - `mark` не отвечает дольше 2 с (поддельные таймеры) → `answerCheckout`
    уже вернул решение, в логе `checkout_mark_failed`;
  - `mark` бросает → решение возвращено, в логе `checkout_mark_failed`;
  - payload не UUID → `mark` не вызван.
- `backend/api/test/payment-checkout-marks.test.ts`:
  - источник: отметка с `refusal: null` → строка «Предварительная проверка
    пройдена»; с `price_mismatch` → «Предварительная проверка: отказ — сумма
    не совпала»; незнакомый код `weird` → «…отказ — weird»; без отметки — пусто;
  - интеграционно (живой Postgres, в этом же файле или
    `payment-checkout-marks.integration.test.ts` — тогда допиши его в
    `zones`): `mark` дважды → `of` отдаёт последнюю; `mark` по
    несуществующей покупке — без ошибки.

## Аналитика

Нет: строка лога `pre_checkout` остаётся как есть, факт — в колонках покупки.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md` §1.1: в `PURCHASE` — две строки
  `datetime checkout_at "nullable: последняя предварительная проверка (Р209)"`
  и `string checkout_refusal "nullable: отказ этой проверки"`; в потоке
  §4.15 (покупка второго шанса) — шаг «отметка проверки в purchase после
  ответа площадке», если там нарисован `pre_checkout`.

## Критерии приёмки

- [ ] После каждой предварительной проверки у покупки есть время и отказ
      последней проверки; ответ площадке уходит раньше записи.
- [ ] Сбой или медленная запись отметки не задерживает и не ломает ответ.
- [ ] Карточка платежа показывает строку проверки с подписью отказа.
- [ ] Миграция только добавляет две колонки `NULL`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Предварительная проверка в хронологии платежа`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА В ХРОНОЛОГИИ ПЛАТЕЖА**

  Покупка помнит последнюю предварительную проверку оплаты — когда и с каким ответом. В карточке платежа видно «пройдена» или причину отказа: «счёт устарел», «сумма не совпала» и другие.

  🛠 **Поддержка**

  • игрок пишет «не смог оплатить» — причина отказа теперь в карточке платежа, а не только в логе сервера
  ```
