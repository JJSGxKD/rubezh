---
id: T-0025
title: Вторая подписка VIP не оплачивается и не продлевается
epic: E1
priority: P0
status: ready
owner:
size: M
depends_on: [T-0003]
zones:
  - backend/api/src/modules/payments/checkout-answer.ts
  - backend/api/src/modules/payments/purchases.repository.ts
  - backend/api/src/modules/payments/payment-confirmation.ts
  - backend/api/src/modules/vip/vip.service.ts
  - backend/api/test/helpers/memory-purchases.ts
  - backend/api/test/payment-confirmation.test.ts
  - backend/api/test/payments.integration.test.ts
  - backend/api/test/vip.test.ts
shared:
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: patch
design: null
---

# T-0025. Вторая подписка VIP не оплачивается и не продлевается

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0025.json)](README.md#значки-статуса) [![T-0003](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0003.json&label=T-0003)](T-0003-payments-fulfillment-sweeper.md)

## Зачем

Игрок может оплатить VIP дважды и получить две подписки: два списания по
700 ⭐ каждый месяц. Сценарий:

1. Он дважды нажимает «Купить VIP» и получает два счёта: `VipService.order`
   выставляет новый на каждый запрос.
2. Оплачивает оба. Предварительная проверка оплаты не смотрит, идёт ли уже VIP
   с продлением.

Это пункт К5 аудита. Оплата звёздами сейчас выключена, и это одна из причин.

## Решения

- **Предварительная проверка отказывает новой подписке, пока у аккаунта идёт
  VIP с включённым продлением.** Это то же условие, при котором магазин не
  даёт заказать VIP (`canOrder = !(active && renewing)`, `vip.service.ts:257`).
  Продления действующей подписки проверка пропускает, как и сейчас.
- **Две оплаты почти одновременно.** Проверка второй может пройти раньше, чем
  записана первая. Тогда при выдаче второй подписки её продление
  выключается — на площадке и в базе. Оплаченный период остаётся у игрока и
  встаёт за первым: он заплатил, отнимать нечего. Второго списания в
  следующем месяце не будет. Случай пишется в лог уровнем `error`.
- **Выставление счёта не меняем.** Два открытых счёта безвредны: второй не
  пройдёт проверку.
- **Возврат лишней оплаты здесь не делаем.** Период у игрока остаётся, а
  возвраты и отзыв выданного — T-0023 и T-0024.

## Как сейчас

- `backend/api/src/modules/payments/checkout-answer.ts:52-69` — `decideCheckout(view, query, nowMs, enabled)`:
  - отказы по порядку: `disabled`, `unknown_invoice`, `foreign_user`;
  - продление подписки (`isRenewal`) — сразу `ok`;
  - дальше `already_paid`, `price_mismatch`, `stale_invoice`, `run_finished`,
    `continue_taken`.

  Тексты отказов для игрока — `MESSAGES` (строки 35–45), тип —
  `CheckoutRefusal` (строки 21–30).
- `backend/api/src/modules/payments/purchases.repository.ts`:
  - строки 58–66 — `CheckoutView` с полями `purchase`, `platformUserId`,
    `runFinished`, `continueTaken`;
  - строки 283–297 — `checkout(purchaseId)` собирает их одним запросом
    Prisma: на ответ у Telegram десять секунд;
  - строка 137 — в интерфейсе репозитория;
  - строка 317 — вызов внутри `markPaid`.

  У `Account` в схеме есть связи `vipSubscriptions` и `vipPeriods`
  (`prisma/schema.prisma:215-216`), индекс `vip_period (account_id, ends_at)`.
- `backend/api/src/modules/payments/payment-confirmation.ts`:
  - строка 160 — `checkout` для изменения подписки;
  - строка 174 — для проверки оплаты, с таймаутом
    `CHECKOUT_READ_TIMEOUT_MS`. Часы — `nowMs` метода `decide`.
- `backend/api/test/helpers/memory-purchases.ts:140` — `checkout` подмены.
- `backend/api/src/modules/vip/vip.service.ts`:
  - строки 186–202 — `fulfill(purchase)`: период через
    `repository.addPeriod`; если период уже был (`!period.created`) — выход;
  - строки 132–142 — `cancel(account)`: выключает продление у площадки
    (`this.renewal.set(account, subscriptionId, false)`) и в базе
    (`repository.setRenewal(id, "cancelled", by, at)`);
  - `state(accountId, at)` — подписки аккаунта с `renewal`;
  - `AccountRef` для `renewal.set` берётся из аккаунта: `fulfill` знает только
    `purchase.accountId`. `ACCOUNT_REPOSITORY` с методом `byId` внедряется
    так же, как в `wallet.controller.ts`, а `VipModule` уже импортирует
    `AuthModule`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **`purchases.repository.ts`:**
   - `CheckoutView` получает поле:

     ```ts
     /** у владельца идёт VIP и есть подписка с продлением: новая подписка не нужна */
     subscriptionLive: boolean;
     ```

   - `checkout(purchaseId: string, at: Date)` — второй параметр, и в
     интерфейсе тоже. В `select` у `account`:
     - `vipPeriods: { where: { endsAt: { gt: at } }, select: { purchaseId: true }, take: 1 }`;
     - `vipSubscriptions: { where: { renewal: "on" }, select: { subscriptionId: true }, take: 1 }`.

     `subscriptionLive` = оба списка непусты. Запрос остаётся одним;
   - вызов в `markPaid` (строка 317) — с `record.paidAt`. Если такого поля в
     `PaymentRecord` нет — с `new Date()`. На решение `markPaid` новое поле не
     влияет.
3. **`payment-confirmation.ts`** — оба вызова `checkout` с `new Date(nowMs)`
   своего метода.
4. **`memory-purchases.ts`** — `checkout(purchaseId, at)` с полем
   `subscriptionLive`. Подмена берёт его из поля класса
   `subscriptionLive = false`, которое тест может выставить.
5. **`checkout-answer.ts`:**
   - `CheckoutRefusal` += `"subscription_active"`;
   - `MESSAGES.subscription_active = "VIP уже действует — вторая подписка не нужна. Вернитесь в игру."`;
   - в `decideCheckout` сразу после проверки `already_paid`:

     ```ts
     // Новая подписка, пока идёт VIP с продлением, — второе списание каждый месяц.
     if (SUBSCRIPTION_PRODUCTS.includes(purchase.product) && view.subscriptionLive) return refuse("subscription_active");
     ```

     Продление (`isRenewal`) возвращает `ok` раньше этой строки и под отказ
     не попадает.
6. **`vip.service.ts`, `fulfill`:**
   - в конструктор — `@Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">`;
   - после `if (!period.created) return;` и лога `subscription_started` — только
     для новой подписки (`purchase.renewalOf === null`):
     1. `state(purchase.accountId, now)`;
     2. есть подписка с `renewal === "on"` и другим `subscriptionId` → вызвать
        приватный `stopDuplicate(purchase, keptId)`;
   - `stopDuplicate`:
     - аккаунт через `accounts.byId`; его нет — лог `error` и выход;
     - `renewal.set(accountRef, purchase.purchaseId, false)`;
     - `repository.setRenewal(purchase.purchaseId, "cancelled", "game", now)`;
     - лог уровнем `error`, событие `vip_subscription_twice`, поля
       `accountId`, `kept`, `stopped`;
     - ошибка площадки или базы — лог `error` с причиной, без повторного броска.
       Выдача периода уже записана, а повтор задания её не повторит
       (`period.created === false`), так что бросок ничего бы не вернул.

     `AccountRef` — `{ accountId, platform, platformUserId }` из аккаунта.
7. **`docs/35-stage4-plan.md`**, «Как сделано, часть 2 — VIP-подписка Stars»
   (около строки 1798) — пункт: «Вторая подписка: проверка оплаты отказывает
   новой подписке, пока идёт VIP с продлением (`subscription_active`); если
   две оплаты проскочили одновременно, у второй выключается продление, период
   остаётся (T-0025)».

## Чего не трогаем

- `VipService.order` и выставление счетов.
- Продления действующей подписки и `subscriptionChanged`.
- Возвраты и отзыв выданного — T-0023, T-0024.
- Проход довыдачи и уведомления команды — T-0003.

## Тесты

Первым коммитом.

- `backend/api/test/payment-confirmation.test.ts`, «предварительная проверка
  оплаты»:
  - покупка `vip`, не продление, `subscriptionLive: true` → `subscription_active`;
  - та же покупка, `subscriptionLive: false` → `{ ok: true }`;
  - продление (`isRenewal`) при `subscriptionLive: true` → `{ ok: true }`;
  - покупка `shop_item` при `subscriptionLive: true` → `{ ok: true }`;
  - у `subscription_active` текст отказа — из `MESSAGES`.
- `backend/api/test/payments.integration.test.ts`, живой Postgres — `checkout(id, at)`:
  - у аккаунта есть период VIP с `endsAt > at` и подписка с `renewal = on` →
    `subscriptionLive: true`;
  - период кончился → `false`;
  - продление `cancelled` → `false`;
  - VIP нет вовсе → `false`.
- `backend/api/test/vip.test.ts`, `fulfill`:
  - новая подписка, у аккаунта другая с `renewal: "on"` → `renewal.set`
    вызван с `(account, новая, false)`, у новой в базе `cancelled`/`game`,
    первая не тронута, период новой выдан;
  - новая подписка без других → `renewal.set` не вызывался;
  - продление (`renewalOf` задан) при другой продлеваемой → не вызывался;
  - `renewal.set` бросает → `fulfill` не бросает, период выдан.

## Аналитика

Нет новых событий словаря. Отказ проверки уже пишется в лог с причиной.
`vip_subscription_twice` — структурный лог `error`.

## Настройки и окружение

Нет.

## Документы

- `docs/35-stage4-plan.md` — шаг 7.

## Критерии приёмки

- [ ] Вторая подписка VIP при действующем VIP с продлением не проходит
  предварительную проверку; игрок видит «VIP уже действует…».
- [ ] Продление действующей подписки проходит, как раньше.
- [ ] Если две оплаты проскочили, у второй подписки продление выключено на
  площадке и в базе, период выдан, в логе `vip_subscription_twice`.
- [ ] `checkout` остаётся одним запросом к базе.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(payments): Вторая подписка VIP не оплачивается`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено [telegram]: Подписку VIP нельзя случайно оплатить дважды.`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — VIP НЕ ОПЛАЧИВАЕТСЯ ДВАЖДЫ**

  Подписку VIP больше нельзя оплатить второй раз: раньше два открытых счёта давали две подписки и два списания по 700 ⭐ в месяц.

  💳 **Что изменилось**

  • проверка оплаты отказывает новой подписке, пока VIP идёт с продлением
  • если две оплаты проскочили одновременно, у второй подписки выключается продление, оплаченный период остаётся игроку; в лог — ошибка vip_subscription_twice
  ```
