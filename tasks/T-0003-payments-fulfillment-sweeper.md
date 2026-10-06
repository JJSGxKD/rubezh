---
id: T-0003
title: Оплаченное всегда выдаётся или возвращается
epic: E1
priority: P0
status: ready
owner:
size: M
depends_on: [T-0001]
zones:
  - backend/api/src/modules/payments/fulfillment-sweeper.ts
  - backend/api/src/modules/payments/purchase-fulfillment.ts
  - backend/api/src/modules/payments/purchases.repository.ts
  - backend/api/src/modules/payments/payment-refunds.ts
  - backend/api/src/modules/payments/purchase-types.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments-limits.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/payments/payments-queue.ts
  - backend/api/src/modules/shop/shop.service.ts
  - backend/api/src/modules/admin-notify/payments-alert-notifier.ts
  - backend/api/src/modules/admin-notify/admin-notify.module.ts
  - backend/api/src/modules/settings/notify-targets.ts
  - backend/api/test/settings.test.ts
  - backend/api/test/fulfillment-sweeper.test.ts
  - backend/api/test/payments-alert-notifier.test.ts
  - backend/api/test/payments.integration.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: xhigh
release: patch
design: null
---

# T-0003. Оплаченное всегда выдаётся или возвращается

## Зачем

Выдачу товара делает задание очереди `payments`. После десяти неудачных попыток
(около 35 минут) задание бросается, и покупка остаётся оплаченной, но не
выданной навсегда: её никто не подбирает, а команда узнаёт о ней, только если
прочитает лог. Так случилось бы со стартовым набором до T-0001. Так же случится
с любой покупкой снятого с витрины товара, по которой пришла оплата. После
задачи каждая оплата заканчивается выдачей или возвратом звёзд, а о зависшей
команда узнаёт сообщением в чат.

## Решения

- **Довыдача.** Раз в 5 минут, под распределённым локом, проходим по
  покупкам, которые оплачены больше 45 минут назад, не выданы и не
  возвращаются. 45 минут — больше полного цикла повторов задания очереди
  (`JOB_OPTIONS` в `payments-queue.ts`: 10 попыток, экспоненциальная пауза от
  2 с). Проход не спорит с живым заданием, а если и пересечётся — выдача
  идемпотентна ключом в журнале кошелька.
- **Выдать нельзя по сути** (товара больше нет в каталоге) — звёзды
  возвращаются с новой причиной возврата `undeliverable`, через существующую
  цепочку возвратов (`PaymentRefunds`, очередь). Игрок не должен оставаться без
  денег и без товара.
- **Выдача падает по другой причине** (база, кошелёк, ошибка в коде) —
  автоматического возврата нет. Ошибка может быть временной, решает человек.
  Проход пробует снова на каждом тике. Команда получает одно сообщение на
  покупку.
- **Сообщение команде уходит в свой поток «Покупки».** Это новый адрес
  `notify.chat.payments` в каталоге настроек: он правится в панели сразу, в
  разделе настроек уведомлений, и переменной окружения у него нет. Пока адрес
  пуст, сообщение идёт в общий чат администраторов — так `NotifyTargets` уже
  ведёт себя для всех потоков (решение пользователя 06.10.2026: новый поток
  можно заводить, тему в чате создаёт и вписывает в панели участник 1).
  Отправка — через `admin-notify`, по образцу `fx-alert-notifier.ts`. Модуль оплаты о Telegram не знает и только
  объявляет событие через `PaymentsHooks`. Одна покупка — одно сообщение за 7
  суток (ключ Redis `SET NX`).

## Как сейчас

- `backend/api/src/modules/payments/payments-queue.ts`:
  - `process()` → `confirm` → `fulfill(outcome)`;
  - `fulfill` зовёт `PurchaseFulfillment.fulfill`, потом
    `purchases.markFulfilled`;
  - упавшее после 10 попыток задание пишет в лог `payment_job_abandoned` — и
    больше ничего.
- `backend/api/src/modules/payments/purchase-fulfillment.ts`: реестр выдач по
  `PurchaseProduct`. Регистрируются `shop_item`
  (`shop/shop.service.ts:85`) и `vip` (`vip/vip.service.ts:80`). `fulfill`
  возвращает `false`, если у товара нет выдачи — например, у второго шанса.
- `backend/api/src/modules/shop/shop.service.ts`, `fulfill`: если SKU нет в
  каталоге, бросает `new Error("товара … нет в каталоге — выдавать нечего")`.
- Модель `Purchase` (`prisma/schema.prisma`):
  - `paidAt`, `fulfilledAt`, `refundReason`, `refundRequestedAt`, `refundedAt`;
  - перечисление `RefundReason`: `test_mode`, `unused`, `external`.
- `backend/api/src/modules/payments/payment-refunds.ts`: `request(purchaseId,
  reason)` → `purchases.requestRefund` → заказ, который очередь отправляет в
  Telegram и помечает `refunded`.
- Образец прохода под локом — `backend/api/src/modules/boosts/boosts-refunder.ts`:
  - `setInterval`, лок `SET … PX … NX`, снятие своего лока Lua-скриптом;
  - флаг `running`;
  - `tick()` возвращает число или `null`;
  - включается только при `config.auth.enabled`.
- Образец уведомления команды — `backend/api/src/modules/admin-notify/fx-alert-notifier.ts`:
  - подписка на хуки модуля в `onModuleInit`;
  - отправка `sendMessage` с `AbortSignal.timeout`;
  - чат из `NotifyTargets`.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **Миграция.**
   - В `RefundReason` добавить `undeliverable` с комментарием `///` «товар не
     выдать по сути — например, снят с витрины: звёзды возвращаются».
   - Индекс на `Purchase` под проход: `@@index([fulfilledAt, paidAt])` с
     комментарием, зачем он.
   - Миграция — по правилу «Общие файлы» в `tasks/README.md`: `--create-only` на
     отдельной базе, один раз, после перебазирования на свежий `dev`.
   - Добавление значения в enum и индекс — только «expand», план отката не
     нужен.
3. **`purchase-types.ts`.** В `RefundReason` добавить `"undeliverable"`.
4. **`purchase-fulfillment.ts`.**
   - Экспортировать класс `UndeliverableError extends Error`: выдача
     невозможна по сути, повторять бесполезно.
   - Добавить метод `products(): PurchaseProduct[]` — товары с
     зарегистрированной выдачей.
5. **`shop.service.ts`, `fulfill`.** Для неизвестного SKU бросать
   `UndeliverableError` с тем же текстом. Больше ничего в файле не менять.
6. **`purchases.repository.ts`.** Метод интерфейса и реализации:

   ```ts
   /** Оплаченные и не выданные покупки этих товаров старше срока, без заказанного возврата — их подбирает проход довыдачи. */
   undelivered(products: readonly PurchaseProduct[], paidBefore: Date, limit: number): Promise<StoredPurchase[]>;
   ```

   Условие:
   - `paid_at IS NOT NULL AND paid_at < $paidBefore`;
   - `fulfilled_at IS NULL`;
   - `refund_requested_at IS NULL` и `refunded_at IS NULL`;
   - `product = ANY($products)`;
   - `ORDER BY paid_at LIMIT $limit`.

   Строки разбираются тем же способом, что в соседних методах файла.
7. **`payment-refunds.ts`.** Публичный метод `undeliverable(purchaseId, nowMs)`
   → `request(purchaseId, "undeliverable", nowMs)`. Тип параметра `reason` в
   `request` расширить.
8. **`payments-hooks.ts`.**
   - Событие `onStuck(name, listener)` и `emitStuck(stuck)`, где

     ```ts
     interface StuckPurchase { purchaseId: string; accountId: string; product: PurchaseProduct; sku: string | null; chargedStars: number; paidAt: Date; reason: string }
     ```

   - Упавший слушатель не мешает остальным, как у `emitPaid`.
9. **`payments-limits.ts`.** Константа

   ```ts
   FULFILLMENT_SWEEP = { tickMs: 5 * 60_000, lockTtlMs: 4 * 60_000, olderThanMs: 45 * 60_000, batch: 100 }
   ```

   с комментарием про 45 минут из «Решений».
10. **Новый `fulfillment-sweeper.ts`** — класс `FulfillmentSweeper` по образцу
    `boosts-refunder.ts`, лок `payments:fulfill:lock`. На каждую покупку из
    `undelivered(fulfillment.products(), now − olderThanMs, batch)`:
    - `fulfillment.fulfill(purchase)` прошёл → `markFulfilled`, в лог
      `purchase_fulfilled_late`;
    - бросил `UndeliverableError` → `queue.dispatchRefunds(refunds.undeliverable(purchaseId))`:
      заказ записывается в базу и сразу уходит в очередь (шаг 10а). В лог
      `purchase_undeliverable`, в хуки — `emitStuck` с `reason: "undeliverable"`;
    - любая другая ошибка → в лог `purchase_still_undelivered` с причиной, в
      хуки — `emitStuck` с `reason` = текст ошибки.

    Каждая покупка обрабатывается в своём `try`: сбой одной не останавливает
    проход. `tick()` возвращает `{ fulfilled, refunded, stuck }` или `null`.
    Включается при `queue.enabled` (`PaymentsQueue` внедряется в проход) — там
    же, где включена сама очередь оплаты.

10а. **`payments-queue.ts`.** Приватный `refundAll(orders)` переименовать в
    публичный `dispatchRefunds(orders: Promise<RefundOrder[]>): Promise<void>`
    и обновить его вызовы внутри файла. Поведение не меняется: заказанные
    возвраты отправляются заданиями очереди. Больше в файле ничего не менять —
    остальное здесь делает T-0004.
11. **`payments.module.ts`.** Зарегистрировать `FulfillmentSweeper`.

11а. **Поток «Покупки».**
    - В `settings/setting-catalog.ts`, в `SETTINGS`, после `chatRunReview`:

      ```ts
      chatPayments: chat(
        "notify.chat.payments",
        "Покупки",
        "Невыданные покупки, возвраты за снятые товары и брошенные задания оплаты. Пусто — общий чат",
        () => "",
      ),
      ```

      Переменной окружения нет, адрес задаётся только в панели. Если тест
      каталога требует у каждого адреса переменную окружения — это вопрос
      тимлидам, а не новая переменная.
    - В `settings/notify-targets.ts`: поле `payments: ChatTarget | null` в
      `AdminChats` с комментарием и `payments: orGeneral(SETTINGS.chatPayments)`
      в `chats()`.
    - Панель показывает каталог сама. Если раздел настроек в `apps/admin`
      перечисляет адреса чатов списком, а не берёт их из ответа сервера, — это
      вопрос тимлидам.
12. **Новый `admin-notify/payments-alert-notifier.ts`** — по образцу
    `fx-alert-notifier.ts`:
    - подписка на `PaymentsHooks.onStuck`;
    - дедупликация `SET payments:stuck-alert:<purchaseId> 1 EX 604800 NX`;
    - отправка в `targets.chats().payments` с таймаутом: пустой адрес уже
      заменён общим чатом внутри `NotifyTargets`;
    - нет чата или Redis — в лог и молча дальше.

    Текст сообщения:

    ```
    ⚠️ Покупка не выдана
    Товар: <sku или product>, <chargedStars> ⭐
    Аккаунт: <accountId>
    Оплачена: <paidAt UTC, ГГГГ-ММ-ДД ЧЧ:ММ>
    Причина: <reason>
    <если undeliverable: «Звёзды возвращаются автоматически.» иначе: «Проход повторяет выдачу каждые 5 минут; нужна проверка.»>
    ```

    Зарегистрировать в `admin-notify.module.ts`.
13. Документы (раздел «Документы»), гейт.

## Чего не трогаем

- `telegram-payments.handler.ts`, `payments.service.ts` и всё в
  `payments-queue.ts`, кроме `dispatchRefunds`, — это T-0004: внешние возвраты
  через очередь и алерт по брошенному заданию.
- Каталог магазина и тесты магазина — это T-0001.
- Ручной возврат и повторная выдача из панели — отдельная задача эпика E1.

## Тесты

Первым коммитом.

1. `backend/api/test/fulfillment-sweeper.test.ts` — юнит, на подменах
   репозитория, выдачи, возвратов, хуков и Redis:
   - покупка, выдача прошла → `markFulfilled` вызван, хук не вызван, `fulfilled: 1`;
   - выдача бросила `UndeliverableError` → заказан возврат `undeliverable` и
     передан в `queue.dispatchRefunds`; `emitStuck` с `reason: "undeliverable"`;
     `markFulfilled` не вызван;
   - выдача бросила обычную ошибку → ни выдачи, ни возврата, `emitStuck` с
     текстом ошибки;
   - вторая покупка обрабатывается, даже если первая упала;
   - лок занят → `tick()` возвращает `null` и репозиторий не зовётся;
   - срок отбора — `now − 45 мин`, в `undelivered` уходят товары из `fulfillment.products()`.
2. `backend/api/test/payments-alert-notifier.test.ts` — юнит:
   - первое событие по покупке → одно сообщение с товаром, звёздами и
     причиной;
   - повтор того же `purchaseId` → сообщения нет (ключ уже есть);
   - `undeliverable` — строка «Звёзды возвращаются автоматически.»;
   - нет чата → не отправляет и не бросает.
3. `backend/api/test/settings.test.ts`, рядом с кейсом про `runReview` (около
   строки 151): адрес `notify.chat.payments` пуст → `chats().payments` равен
   общему чату; задан `-100:57` → `{ chatId: "-100", threadId: 57 }`.
4. `backend/api/test/payments.integration.test.ts` — новый кейс на живом
   Postgres. `undelivered` отдаёт только оплаченную, старую, не выданную и не
   возвращаемую покупку нужного товара. Выданную, свежую, с заказанным
   возвратом и товар не из списка — не отдаёт.

## Аналитика

Нет. Это служебный проход. Его исходы — в логах (`purchase_fulfilled_late`,
`purchase_undeliverable`, `purchase_still_undelivered`) и в сообщении команде.

## Настройки и окружение

Нет. Интервал и срок — константы `FULFILLMENT_SWEEP` в `payments-limits.ts`.

## Документы

- `docs/21-diagrams.md`:
  - в ER-диаграмме у `RefundReason` или `PURCHASE` — значение `undeliverable`,
    если перечисление там есть;
  - в схеме модулей — связь `PAYMENTS → ADMIN_NOTIFY` через хук, по образцу
    связи курсов.
- `docs/30-configuration-map.md` — две строки:
  - «Довыдача оплаченных покупок: интервал, срок, размер пачки —
    `FULFILLMENT_SWEEP` в `payments/payments-limits.ts`»;
  - «Поток «Покупки» в чате команды — `notify.chat.payments` в панели, пусто —
    общий чат» — рядом со строками остальных адресов `notify.chat.*`.
- `docs/35-stage4-plan.md`, раздел «Как сделано» WP10 — абзац о проходе
  довыдачи и причине `undeliverable`.

## Критерии приёмки

- [ ] Покупка, у которой выдача упала, через 45 минут подбирается проходом и выдаётся. Повтор не удваивает.
- [ ] Покупка снятого товара получает возврат `undeliverable`.
- [ ] О зависшей покупке в чат команды приходит одно сообщение.
- [ ] Миграция одна. В ней только новое значение перечисления и индекс.
- [ ] Новые тесты зелёные, интеграционный — в CI PR.
- [ ] Документы обновлены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(payments): Довыдавать оплаченное или возвращать звёзды`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено [telegram]: Если покупка не выдалась сразу, игра выдаст её позже сама, а если товар выдать нельзя — вернёт звёзды.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОПЛАЧЕННОЕ ВСЕГДА ВЫДАЁТСЯ ИЛИ ВОЗВРАЩАЕТСЯ**

  Раньше покупка, у которой не прошла выдача, зависала навсегда. Теперь раз в 5 минут проход довыдаёт такие покупки, а за снятые товары возвращает звёзды. О каждой зависшей покупке приходит сообщение в чат команды.

  ❓ **Нужно от команды**

  • @участник1 — создать в чате команды тему «Покупки» и вписать её адрес в панели (настройка `notify.chat.payments`, формат `id чата:тема`); до этого сообщения идут в общий чат
  ```
