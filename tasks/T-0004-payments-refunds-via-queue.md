---
id: T-0004
title: Внешние возвраты через очередь и сигнал о брошенном задании
epic: E1
priority: P0
status: ready
owner:
size: S
depends_on: [T-0003]
zones:
  - backend/api/src/modules/payments/payments-queue.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments.service.ts
  - backend/api/src/platforms/telegram/telegram-payments.handler.ts
  - backend/api/src/modules/admin-notify/payments-alert-notifier.ts
  - backend/api/test/payment-confirmation.test.ts
  - backend/api/test/payments.test.ts
  - backend/api/test/payments-queue.test.ts
  - backend/api/test/payments-alert-notifier.test.ts
shared:
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0004. Внешние возвраты через очередь и сигнал о брошенном задании

## Зачем

Три дыры рядом с T-0003:

1. **Возврат от Telegram пишется в базу мимо очереди.** Это возврат по спору
   или через поддержку, обновление `refunded_payment`. Смещение опроса к этому
   моменту уже сохранено, поэтому сбой базы теряет отметку навсегда: покупка
   остаётся «оплаченной», выручка завышена.
2. **Задание оплаты, брошенное после 10 попыток, видно только в логе.**
   Например, подтверждение не записалось, пока база лежала.
3. **Пока оплата выключена в панели, клиент не видит состояние своей
   покупки.** `GET /api/v1/payments/:id` отвечает 404, и игрок, оплативший
   до выключения, не узнаёт, что покупка выдана.

## Решения

- `refunded_payment` идёт тем же путём, что `successful_payment`: в очередь
  `payments`, запись в базу повторяется до успеха. Идентификатор задания —
  отпечаток `telegram_payment_charge_id`: повтор обновления не заводит второе
  задание.
- О брошенном задании (`payment_job_abandoned`) команда узнаёт сообщением в
  поток «Покупки» (`notify.chat.payments`, пусто — общий чат). Это тот же уведомитель, что в T-0003
  (`admin-notify/payments-alert-notifier.ts`), новое событие хуков. Одно
  сообщение на задание (ключ — `jobId`, 7 суток).
- Стоп-кран `payments.stars` закрывает только **новые** счета и цены. Чтение
  состояния своей покупки работает всегда: уже оплаченное засчитывается и без
  стоп-крана (`assertEnabled` об этом и говорит).

## Как сейчас

- `backend/api/src/platforms/telegram/telegram-payments.handler.ts`, около
  строки 61: `refunded_payment` → `await this.confirmation.refunded(chargeId)`
  прямо в обработчике. `successful_payment` уже идёт через `this.queue.confirm(…)`.
- `backend/api/src/modules/payments/payments-queue.ts`:
  - `type PaymentsJob = { kind: "confirm"; … } | { kind: "refund"; … }`;
  - `process()` разбирает вид задания;
  - `run(job, jobId)` ставит задание в очередь, а без Redis выполняет сразу;
  - `fingerprint(chargeId)` строит отпечаток;
  - обработчик `worker.on("failed")` пишет `payment_job_abandoned` на последней
    попытке;
  - после T-0003 там же есть публичный `dispatchRefunds`.
- `backend/api/src/modules/payments/payment-confirmation.ts`,
  `refunded(chargeId, nowMs)` — запись возврата; её не трогаем.
- `backend/api/src/modules/payments/payments.service.ts`, `purchase(account,
  purchaseId)` — первая строка `this.assertEnabled()`.
- После T-0003 в `payments-hooks.ts` есть `onStuck` и `emitStuck`, а в
  `admin-notify/payments-alert-notifier.ts` — уведомитель.
- Тесты, которые закрепляют нынешнее поведение:
  - `backend/api/test/payment-confirmation.test.ts`, кейс «проверку,
    подтверждение и возврат разбирает оплата…» (около строки 196): ждёт
    `refunded:charge-1` от `confirmation`;
  - `backend/api/test/payments.test.ts`, «выключенная оплата отвечает как
    несуществующая» (около строки 166) — про `quote`, он остаётся.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **`payments-queue.ts`:**
   - в `PaymentsJob` добавить `{ kind: "refunded"; chargeId: string; at: number }`;
   - публичный `refunded(chargeId: string, nowMs = Date.now()): Promise<void>` →
     `run({ kind: "refunded", chargeId, at: nowMs }, \`refunded-${fingerprint(chargeId)}\`)`;
   - в `process()` вид `refunded` → `await this.confirmation.refunded(data.chargeId, data.at)`;
   - `describeJob` для `refunded` — `{ kind, chargeId }`;
   - в `run` событие лога для `refunded` — `refund_unrecorded`.
3. **`payments-queue.ts`, обработчик `failed`.** При `final` дополнительно
   вызвать `this.hooks.emitAbandoned({ jobId: job.id ?? "", kind: job.data.kind,
   chargeId, purchaseId, reason: error.message })`:
   - `chargeId` и `purchaseId` берутся из `describeJob`;
   - `PaymentsHooks` внедрить в конструктор `PaymentsQueue`;
   - вызов не должен бросать.
4. **`payments-hooks.ts`.** Событие `onAbandoned` и `emitAbandoned` с типом

   ```ts
   interface AbandonedJob { jobId: string; kind: "confirm" | "refund" | "refunded"; chargeId: string; purchaseId: string | null; reason: string }
   ```

   Упавший слушатель не мешает остальным — как у остальных событий.
5. **`telegram-payments.handler.ts`.** Для `refunded_payment` →
   `await this.queue.refunded(message.refunded_payment.telegram_payment_charge_id)`.
   Зависимость от `confirmation` остаётся: она нужна проверке перед оплатой и
   подпискам.
6. **`admin-notify/payments-alert-notifier.ts`.** Подписка на `onAbandoned`,
   дедупликация `SET payments:abandoned-alert:<jobId> 1 EX 604800 NX`. Текст:

   ```
   ⚠️ Задание оплаты брошено после всех попыток
   Вид: <подтверждение | возврат | внешний возврат>
   Оплата: <chargeId>
   Покупка: <purchaseId или «—»>
   Причина: <reason>
   Нужна ручная сверка покупки.
   ```

7. **`payments.service.ts`, `purchase()`.** Убрать `this.assertEnabled()`. Над
   методом — комментарий: состояние своей покупки видно и при выключенной
   оплате, стоп-кран закрывает только новые счета. Остальные вызовы
   `assertEnabled` не трогать.
8. Документы, гейт.

## Чего не трогаем

- `payment-confirmation.ts`: логика записи возврата и подписки остаётся.
- Отзыв выданного при внешнем возврате (самоцветы, VIP) — отдельная задача
  после решения О4. Здесь только надёжная запись факта возврата.
- Проход довыдачи и его тесты — это T-0003.

## Тесты

Первым коммитом.

1. `backend/api/test/payment-confirmation.test.ts`, кейс «проверку,
   подтверждение и возврат разбирает оплата…»:
   - подмена очереди получает метод `refunded`;
   - ожидание `refunded:charge-1` переходит с `confirmation` на очередь: в
     `calls` от `confirmation` остаётся только `checkout:p-1`, а очередь
     получила `refunded("charge-1")`.
2. Новый `backend/api/test/payments-queue.test.ts` — `process()` без BullMQ, на
   подменах:
   - задание `refunded` зовёт `confirmation.refunded(chargeId, at)` с теми же
     значениями;
   - без очереди (`queue === null`) `refunded()` выполняет запись сразу;
   - ошибка записи не пробивается наружу и пишет `refund_unrecorded`;
   - идентификатор задания — `refunded-<отпечаток>`, у двух вызовов с одним
     `chargeId` он одинаковый.

   Если обработчик `failed` не удаётся вызвать без BullMQ, вынеси решение
   «последняя попытка → `emitAbandoned`» в маленькую экспортируемую функцию и
   тестируй её.
3. `backend/api/test/payments-alert-notifier.test.ts`:
   - событие `onAbandoned` → одно сообщение с видом, оплатой и причиной;
   - повтор того же `jobId` → сообщения нет.
4. `backend/api/test/payments.test.ts`, новый кейс «состояние своей покупки
   видно и при выключенной оплате»:
   - `build(config({ PAYMENTS_ENABLED: "false" }))`;
   - `service.purchase(me, purchaseId)` своей покупки отвечает её состоянием,
     а не `endpoint_disabled`;
   - `quote` по-прежнему `endpoint_disabled` — существующий кейс остаётся.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

`docs/35-stage4-plan.md`, «Как сделано» WP10, абзац об очереди оплаты:
- внешние возвраты идут через очередь;
- о брошенном задании приходит сообщение команде;
- состояние покупки видно и при выключенной оплате.

## Критерии приёмки

- [ ] `refunded_payment` записывается заданием очереди. Повтор обновления не заводит второе задание.
- [ ] Брошенное после всех попыток задание даёт одно сообщение в чат команды.
- [ ] `GET /api/v1/payments/:id` отвечает состоянием своей покупки при выключенной оплате. Новые счета и цены по-прежнему закрыты.
- [ ] Новые и изменённые тесты зелёные.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(payments): Внешние возвраты через очередь`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВНЕШНИЕ ВОЗВРАТЫ ЧЕРЕЗ ОЧЕРЕДЬ И СИГНАЛ О БРОШЕННОМ ЗАДАНИИ**

  Возврат звёзд по спору или через поддержку Telegram теперь записывается через очередь и не теряется при сбое базы. О задании оплаты, брошенном после всех попыток, приходит сообщение в чат команды. Игрок видит состояние своей покупки, даже когда оплата выключена в панели.
  ```
