---
id: T-0037
title: Поддержка возвращает звёзды и повторяет выдачу покупки — сервер
epic: E1
priority: P0
status: ready
owner:
size: M
depends_on: [T-0024]
zones:
  - backend/api/src/modules/payments/purchase-support.ts
  - backend/api/src/modules/payments/payments-errors.ts
  - backend/api/src/modules/payments/payment-refunds.ts
  - backend/api/src/modules/payments/purchase-types.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/admin/admin-purchases.controller.ts
  - backend/api/src/modules/admin/admin-players.service.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/admin/dto/admin.dto.ts
  - backend/api/src/modules/admin-notify/payments-alert-notifier.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/test/purchase-support.test.ts
  - backend/api/test/admin-purchases.test.ts
  - backend/api/test/admin-players.test.ts
  - backend/api/test/payments-alert-notifier.test.ts
  - backend/api/test/roles.test.ts
  - backend/api/test/payment-confirmation.test.ts
  - backend/api/test/payment-provider.test.ts
  - backend/api/test/shop.test.ts
  - backend/api/test/subscription-payments.test.ts
  - backend/api/test/vip.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
---

# T-0037. Поддержка возвращает звёзды и повторяет выдачу покупки — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0037.json)](README.md#значки-статуса) [![T-0024](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0024.json&label=T-0024)](T-0024-refund-closes-purchases.md)

## Зачем

После T-0003 о зависшей покупке команда узнаёт сообщением, но сделать с ней
ничего не может. Нельзя повторить выдачу после починки и нельзя вернуть игроку
звёзды по жалобе. Эта задача добавляет оба действия на сервер: право, проверки,
журнал, сообщение команде. Кнопки в карточке игрока делает T-0038.

## Решения

Решения пользователя от 07.10.2026:

- **Кто может — владелец и админ.** Новое право `payments.support`. Каждое
  действие — с обязательной причиной и в журнале действий.
- **Ручной возврат выданной покупки забирает остаток**, как внешний возврат
  в T-0023: самоцветы и другие ресурсы покупки — до того, что есть на счёте,
  у VIP — неиспользованную часть периода, продление выключается. Механика
  отзыва — `PurchaseRevocation` из T-0023, своей не пишем.
- **Отдельного экрана зависших покупок нет.** Поддержка находит покупку через
  сообщение в потоке «Покупки» и карточку игрока.
- **О каждом ручном действии сообщение в поток «Покупки»** (`notify.chat.payments`):
  кто, кому, что и причина.

Решения тимлидов:

- **Новая причина возврата `manual`** — «вернула поддержка». Покупки аккаунту
  после неё не закрываются: T-0024 закрывает их только при `external`, а
  ручной возврат — наше решение, а не злоупотребление игрока.
- **Остаток забирается после того, как звёзды ушли, а не до.** Если площадка
  окончательно откажет в возврате, игрок не останется ни без звёзд, ни без
  товара. Отзыв встроен в задание возврата: при сбое задание повторяется.
  Повтор безопасен на каждом шаге:
  - Telegram на повторный возврат отвечает «уже возвращено» (`already_refunded`);
  - `markRefunded` идемпотентен;
  - отзыв идемпотентен ключами (T-0023).
- **Что открыто по покупке, решает сервер.** Карточка игрока отдаёт у каждой
  покупки список `actions`, и панель показывает только эти кнопки. Перед
  действием сервер проверяет всё ещё раз.
- **Себе нельзя.** Вернуть звёзды или выдать свою покупку нельзя — как с
  кошельком (`wallet.service.ts`, `adjust`). Исключение — вход разработчика
  (`config.auth.devLogin`), чтобы проверить на себе.
- **Повторная выдача идёт сразу, в запросе**, а не заданием: поддержка должна
  видеть, прошла ли она. Дважды не выдаст: у выдачи магазина ключ в журнале
  кошелька, у VIP — период по `purchaseId`.

## Как сейчас

- **Возвраты — `payments/payment-refunds.ts`:**
  - `request(purchaseId, reason, nowMs)` (строка ~99) → `purchases.requestRefund`
    пишет причину и время заказа, только если возврата ещё нет;
  - `refund(order, nowMs)` (строки 80–96) — задание очереди: `provider.refund`,
    затем `purchases.markRefunded(chargeId, at)`. Результат `markRefunded`
    (`RefundedRecord`: `purchase`, `firstTime`) сейчас не используется;
  - конструктор — `PURCHASES_REPOSITORY` и `PaymentProviders`.
- **Очередь — `payments-queue.ts`:** `dispatchRefunds(orders: Promise<RefundOrder[]>)`
  ставит задания возврата; ошибку пишет в лог и наружу не пробрасывает.
- **Отзыв остатка — `payments/purchase-revocation.ts` (T-0023):**
  `revoke(purchase, at): Promise<{ lines: string[] }>`; товар без отзыва даёт
  `["ничего — товар не забирается"]`.
- **Выдача — `PurchaseFulfillment`:**
  - `products()` — товары с выдачей;
  - `fulfill(purchase)`;
  - `UndeliverableError` — товара нет в каталоге (T-0003).
- **Репозиторий покупок — `purchases.repository.ts`:**
  - `byId(purchaseId)`;
  - `markFulfilled(purchaseId, at)` — только если ещё не выдано;
  - `requestRefund(purchaseId, reason, at)`.
- **Причины возврата:**
  - `RefundReason` в `purchase-types.ts:9`;
  - enum `RefundReason` в `prisma/schema.prisma:~94`;
  - после T-0003: `test_mode`, `unused`, `external`, `undeliverable`.
- **Хуки — `payments-hooks.ts`:** `onPaid`, `onSubscriptionChanged`,
  `onStuck` (T-0003), `onExternalRefund` (T-0024). Все устроены одинаково:
  упавший слушатель пишется в лог и не мешает остальным.
- **Сообщения команде — `admin-notify/payments-alert-notifier.ts`:**
  - карточки о невыдаче (T-0003) и о внешнем возврате (T-0024);
  - адрес — `targets.chats().payments`;
  - отправка — `api.sendMessage(chat, text, AbortSignal.timeout(…))`, простой
    текст без разметки.
- **Образец действия в панели — ручная операция с кошельком:**
  - маршрут `POST admin/players/:accountId/wallet/adjust`
    (`admin/admin-players.controller.ts:78-85`): `@RequirePermission`, лимит
    `ADMIN_LIMITS.mutate`, разбор тела через `parse(...)`;
  - сервис `wallet.service.ts:147-180`:
    - `roles.require`;
    - запрет «себе» при выключенном `devLogin`;
    - `roles.audit({ actorAccountId, action, target, before, after })`.
- **Образец отдельного контроллера под игроком — `admin/admin-restrictions.controller.ts`**
  и его HTTP-тест `test/restrictions.test.ts:367-420`. Сессия панели —
  `MemoryAdminSessionStore`, заголовки `cookie` и `ADMIN_CSRF_HEADER`.
- **Карточка игрока — `admin/admin-players.service.ts:114-150`, `card`:**
  - покупки — `purchases.byAccount(accountId, PURCHASES_SHOWN)`, только при
    праве `analytics.revenue.view`;
  - тип поля — `purchases: StoredPurchase[] | null` (строка 62).
- **Права — `roles/permissions.ts`:**
  - `owner` получает все права автоматически (`owner: PERMISSIONS`);
  - у `admin` права перечислены списком;
  - тест `test/roles.test.ts` проверяет, что у владельца есть всё.
- **Ошибки оплаты — `payments/payments-errors.ts`:** `PurchaseNotFoundError`
  (404) и другие. Сам класс — `DomainError(code, message, status)` из
  `common/domain-error.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция.**
   - В enum `RefundReason` (`schema.prisma`) добавить `manual` с комментарием
     `/// вернула поддержка из панели; остаток покупки забирается после возврата`.
   - Миграция — по правилу «Общие файлы» в `tasks/README.md`:
     - `--create-only` на отдельной базе, один раз, после перебазирования на
       свежий `dev`;
     - в ней только `ALTER TYPE "RefundReason" ADD VALUE 'manual';`.
   - Только «expand», план отката не нужен.
3. **`purchase-types.ts`:**
   - `RefundReason` += `"manual"`;
   - новый тип:

     ```ts
     /** Что поддержка может сделать с покупкой сейчас: вернуть звёзды или повторить выдачу. */
     export type PurchaseAction = "refund" | "fulfill";
     ```
4. **`payments-errors.ts`** — три ошибки:

   ```ts
   /** Действие с покупкой сейчас невозможно — текст говорит почему: не оплачена, уже выдана, возврат уже заказан. */
   export class PurchaseActionUnavailableError extends DomainError {
     constructor(message: string) {
       super("purchase_action_unavailable", message, 409);
     }
   }

   /** Товара нет в каталоге — выдать нельзя, остаётся вернуть звёзды. */
   export class PurchaseUndeliverableError extends DomainError {
     constructor() {
       super("purchase_undeliverable", "Товара нет в каталоге — выдать нельзя. Верните звёзды", 409);
     }
   }

   /** Выдача упала не по сути товара: база, кошелёк, ошибка в коде. Подробности — в логе сервера. */
   export class FulfillFailedError extends DomainError {
     constructor() {
       super("fulfill_failed", "Выдача не прошла — подробности в логе сервера. Попробуйте позже", 503);
     }
   }
   ```
5. **`payment-refunds.ts`:**
   - конструктор третьим параметром — `private readonly revocation: PurchaseRevocation`;
   - публичный метод:

     ```ts
     /** Возврат по решению поддержки (`purchase-support.ts`): звёзды, а после них — остаток покупки. */
     async manual(purchaseId: string, nowMs = Date.now()): Promise<RefundOrder[]> {
       return await this.request(purchaseId, "manual", nowMs);
     }
     ```

     тип `reason` в `request` — `+ "manual"`;
   - в `refund(order, nowMs)`:
     - результат `markRefunded` сохранить в переменную;
     - если запись есть и `record.purchase.refundReason === "manual"`, то **при
       каждом вызове**, а не только при `firstTime`:
       `const revocation = await this.revocation.revoke(record.purchase, record.purchase.refundedAt ?? new Date(nowMs))`;
     - ошибка отзыва бросается дальше: задание повторится, а площадка на
       повтор ответит «уже возвращено»;
     - в лог `refund_done` — поле `revoked: revocation.lines`, только у
       `manual`;
     - комментарий над блоком — почему отзыв после возврата, а не до (раздел
       «Решения»);
   - в комментарий класса, в список случаев, — пункт «по решению поддержки —
     из панели (`purchase-support.ts`), остаток покупки забирается после
     возврата».
6. **`payments-hooks.ts`** — событие по образцу `onStuck`:

   ```ts
   /** Действие поддержки с покупкой — для сообщения команде. */
   export interface SupportAction {
     kind: PurchaseAction;
     purchase: StoredPurchase;
     /** имя того, кто сделал, — как в аккаунте; нет аккаунта — его id */
     actorName: string;
     note: string;
     at: Date;
   }

   onSupport(name: string, listener: (action: SupportAction) => Promise<void>): void;
   emitSupport(action: SupportAction): Promise<void>;
   ```
7. **Новый `payments/purchase-support.ts`** — `PurchaseSupport`:

   ```ts
   const FULFILL_TIMEOUT_MS = 10_000;

   export interface SupportResult {
     purchase: StoredPurchase;
     actions: PurchaseAction[];
   }

   @Injectable()
   export class PurchaseSupport {
     constructor(
       @Inject(APP_CONFIG) private readonly config: AppConfig,
       @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
       @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
       private readonly roles: RolesService,
       private readonly fulfillment: PurchaseFulfillment,
       private readonly refunds: PaymentRefunds,
       private readonly queue: PaymentsQueue,
       private readonly hooks: PaymentsHooks,
     ) {}

     /** Что открыто по покупке сейчас. Право вызывающий проверяет сам. */
     actionsFor(purchase: StoredPurchase): PurchaseAction[];
     refund(actor: AccountRef, accountId: string, purchaseId: string, note: string, now = new Date()): Promise<SupportResult>;
     fulfill(actor: AccountRef, accountId: string, purchaseId: string, note: string, now = new Date()): Promise<SupportResult>;
   }
   ```

   Параметры конструктора — сами классы, `Pick` только у параметров с
   `@Inject(токен)`. Иначе Nest не поднимет приложение: на этом упал первый
   заход T-0003.

   **`actionsFor`:**
   - `"refund"` — если `paidAt !== null`, `telegramChargeId !== null`,
     `refundRequestedAt === null` и `refundedAt === null`;
   - `"fulfill"` — если `paidAt !== null`, `fulfilledAt === null`,
     `refundRequestedAt === null`, `refundedAt === null` и
     `fulfillment.products().includes(purchase.product)`;
   - порядок в ответе — `["fulfill", "refund"]`: сначала то, что не стоит денег.

   **Общее начало обоих действий** — приватный `load(actor, accountId, purchaseId, kind)`:
   1. `await this.roles.require(actor, "payments.support")`;
   2. `purchases.byId(purchaseId)`. `null` или `purchase.accountId !== accountId` →
      `PurchaseNotFoundError`;
   3. `actor.accountId === purchase.accountId && !this.config.auth.devLogin` →
      `ForbiddenError`:
      - для возврата — «Возвращать звёзды за свою покупку нельзя»;
      - для выдачи — «Выдавать свою покупку нельзя»;
   4. действия нет в `actionsFor(purchase)` → `PurchaseActionUnavailableError`
      с первой подходящей причиной:

      | Условие | Текст |
      |---|---|
      | `paidAt === null` | «Покупка не оплачена» |
      | `refundedAt !== null` | «Звёзды за покупку уже возвращены» |
      | `refundRequestedAt !== null` | «Возврат уже заказан — звёзды в пути» |
      | возврат, `telegramChargeId === null` | «У оплаты нет номера площадки — вернуть её отсюда нельзя» |
      | выдача, `fulfilledAt !== null` | «Покупка уже выдана» |
      | выдача, товара нет в `products()` | «У этого товара нет выдачи: второй шанс засчитывается в забеге» |

   **`refund`:**
   1. `load(…, "refund")`;
   2. `orders = await this.refunds.manual(purchaseId, now.getTime())`. Пустой
      список — значит, возврат успели заказать параллельно →
      `PurchaseActionUnavailableError("Возврат уже заказан — звёзды в пути")`;
   3. `await this.queue.dispatchRefunds(Promise.resolve(orders))`. Сбой
      постановки не страшен: заказ уже в базе, и очередь поднимет его при
      перезапуске (`PENDING_REFUNDS_ON_START`);
   4. аудит:

      ```ts
      { actorAccountId: actor.accountId, action: "payments.refund", target: accountId,
        before: { purchaseId, fulfilledAt }, after: { purchaseId, reason: "manual", chargedStars, note } }
      ```
   5. `hooks.emitSupport({ kind: "refund", purchase: updated, actorName, note, at: now })`:
      - `updated` — `purchases.byId` после заказа;
      - `actorName` — `accounts.byId(actor.accountId)?.displayName ?? actor.accountId`;
   6. лог `log` `purchase_refund_ordered` с полями `purchaseId`, `accountId`,
      `actorAccountId`, `chargedStars`;
   7. ответ — `{ purchase: updated, actions: actionsFor(updated) }`.

   **`fulfill`:**
   1. `load(…, "fulfill")`;
   2. `withTimeout(this.fulfillment.fulfill(purchase), FULFILL_TIMEOUT_MS, "выдача покупки")`:
      - `UndeliverableError` → `PurchaseUndeliverableError`;
      - любая другая ошибка → лог `error` `purchase_support_fulfill_failed`
        с `purchaseId` и текстом ошибки → `FulfillFailedError`;
   3. `purchases.markFulfilled(purchaseId, now)`;
   4. аудит `action: "payments.fulfill"`, `before: { purchaseId }`,
      `after: { purchaseId, note }`;
   5. `emitSupport({ kind: "fulfill", … })`, лог `log` `purchase_fulfilled_manually`;
   6. ответ — как у возврата.
8. **`payments.module.ts`** — `PurchaseSupport` в `providers` и `exports`. `PurchaseRevocation`
   там уже есть после T-0023.
9. **Права — `roles/permissions.ts`:**
   - в `PERMISSIONS`, после `"players.wallet.adjust"`:

     ```ts
     // Поддержка покупок: вернуть звёзды (остаток товара забирается) и повторить
     // выдачу — владелец и админ; каждое действие с причиной, в журнале и в потоке «Покупки»
     "payments.support",
     ```
   - в `admin` — `"payments.support"` после `"players.message"`. Другим ролям
     не добавлять.
10. **`admin/dto/admin.dto.ts`:**

    ```ts
    export const purchaseIdSchema = z.string().uuid();
    /** Причина действия поддержки — в журнал и в сообщение команде. */
    export const purchaseSupportSchema = z.object({ note: z.string().trim().min(3).max(200) });
    ```
11. **Новый `admin/admin-purchases.controller.ts`** по образцу
    `admin-restrictions.controller.ts`:

    ```ts
    @Controller("admin/players/:accountId/purchases")
    @UseGuards(AdminSessionGuard, PermissionGuard)
    export class AdminPurchasesController {
      @Post(":purchaseId/refund")
      @RequirePermission("payments.support")
      refund(...): Promise<{ data: SupportResult }>;

      @Post(":purchaseId/fulfill")
      @RequirePermission("payments.support")
      fulfill(...): Promise<{ data: SupportResult }>;
    }
    ```

    - `accountId` — `accountIdSchema`, `purchaseId` — `purchaseIdSchema`. Ошибки разбора:
      «Некорректный идентификатор аккаунта» и «Некорректный идентификатор покупки»;
    - тело — `purchaseSupportSchema`, ошибка — «Укажите причину: от 3 до 200 символов»;
    - лимит `ADMIN_LIMITS.mutate` по `actor.accountId`, текст — как в
      `admin-players.controller.ts`;
    - логики в контроллере нет.

    Зарегистрировать в `admin.module.ts`, в `controllers`.
12. **Карточка игрока — `admin-players.service.ts`:**
    - тип:

      ```ts
      /** Покупка в карточке — с тем, что поддержка может сделать сейчас; без права `payments.support` список пуст. */
      export type CardPurchase = StoredPurchase & { actions: PurchaseAction[] };
      ```

      поле карточки — `purchases: CardPurchase[] | null`;
    - в `card`:
      - `roles.can(actor, "payments.support")` — в тот же `Promise.all`, что
        `withPii` и `withPayments`;
      - каждой покупке — `actions: withSupport ? this.support.actionsFor(purchase) : []`;
    - `PurchaseSupport` — новая зависимость, последним параметром конструктора;
    - остальное в карточке не трогать.
13. **`admin-notify/payments-alert-notifier.ts`:**
    - подписка `hooks.onSupport` там же, где `onStuck`;
    - без дедупликации: каждое действие — отдельное решение человека, а
      повторное нажатие сервер отклоняет;
    - отправка в `targets.chats().payments`, нет чата — лог и дальше, как у
      соседних;
    - тексты:

      ```
      ↩️ Возврат звёзд вручную
      Товар: <sku или product>, <chargedStars> ⭐
      Аккаунт: <accountId>
      Кто: <actorName>
      Причина: <note>
      Звёзды вернутся заданием очереди. Если покупка выдана, после возврата заберём остаток.
      ```

      ```
      ✅ Покупка выдана вручную
      Товар: <sku или product>, <chargedStars> ⭐
      Аккаунт: <accountId>
      Кто: <actorName>
      Причина: <note>
      ```

      Функции текста — экспортируемые, рядом со `stuckPurchaseText`:
      `supportActionText(action)`.
    - в `stuckPurchaseText`, в строке для причины не `undeliverable`:
      «Проход повторяет выдачу каждые 5 минут; нужна проверка. В панели:
      карточка игрока → «Покупки».» Строка для `undeliverable` не меняется.
14. **Тесты-соседи.** В пяти файлах, где тесты сами собирают
    `new PaymentRefunds(…)`, третьим аргументом передать
    `new PurchaseRevocation()`:
    - `payment-confirmation.test.ts`;
    - `payment-provider.test.ts`;
    - `shop.test.ts`;
    - `subscription-payments.test.ts`;
    - `vip.test.ts`.

    Больше ничего в них не менять.
15. **Документы** — раздел «Документы».

## Чего не трогаем

- Внешние возвраты и закрытие покупок — T-0023 и T-0024: ручной возврат
  покупки не закрывает, условие `external` там не меняется.
- Проход довыдачи `fulfillment-sweeper.ts` — у него свой цикл.
- Ручную операцию с кошельком и её право `players.wallet.adjust`.
- Панель `apps/admin` — это T-0038.
- `admin-players.controller.ts`: маршруты покупок живут в своём контроллере.

## Тесты

Первым коммитом.

1. **`backend/api/test/purchase-support.test.ts`** — юнит, на подменах:
   `MemoryPurchasesRepository` (`test/helpers/memory-purchases.ts`), роли,
   выдача, очередь, хуки, аккаунты.
   - `actionsFor`:
     - оплаченная невыданная покупка магазина → `["fulfill", "refund"]`;
     - выданная → `["refund"]`;
     - возврат заказан или звёзды вернулись → `[]`;
     - неоплаченная → `[]`;
     - второй шанс (товара нет в `products()`), оплачен → `["refund"]`;
     - без `telegramChargeId` → без `"refund"`.
   - `refund`:
     - заказан возврат с причиной `manual`, заказ передан в `queue.dispatchRefunds`;
     - аудит `payments.refund` с `note`;
     - `emitSupport` с `kind: "refund"` и именем из аккаунта;
     - в ответе `actions: []`.
   - Повторный `refund` той же покупки → `PurchaseActionUnavailableError`,
     текст «Возврат уже заказан — звёзды в пути»; второго заказа нет.
   - Чужая покупка (`accountId` не совпадает) → `PurchaseNotFoundError`.
   - Своя покупка при `devLogin: false` → `ForbiddenError`; при `devLogin: true`
     — проходит.
   - Без права `payments.support` → ошибка доступа из `roles.require`,
     репозиторий не зовётся.
   - `fulfill`:
     - выдача прошла → `markFulfilled`, аудит `payments.fulfill`,
       `emitSupport` с `kind: "fulfill"`;
     - выдача бросила `UndeliverableError` → `PurchaseUndeliverableError`, без
       `markFulfilled`, без аудита;
     - выдача бросила обычную ошибку → `FulfillFailedError`, без `markFulfilled`;
     - уже выданная → `PurchaseActionUnavailableError` «Покупка уже выдана».
   - Задание возврата `PaymentRefunds.refund` с подменой провайдера и
     `PurchaseRevocation` с зарегистрированным отзывом-шпионом:
     - причина `manual` → отзыв вызван один раз, в логе `refund_done`
       поле `revoked`;
     - причина `unused` → отзыв не вызван;
     - повтор задания `manual` (провайдер отвечает `already_refunded`) →
       отзыв вызван снова: доделывает, если первый раз упал;
     - отзыв бросил → `refund` бросает, задание повторится.
2. **`backend/api/test/admin-purchases.test.ts`** — HTTP по образцу
   `test/restrictions.test.ts:367-420`, `PurchaseSupport` — подмена:
   - админ → 200, `{ data: { purchase, actions } }`, сервис вызван с `note`
     без пробелов по краям;
   - модератор (нет права) → 403;
   - тело без `note` или `note` из двух символов → 400;
   - `purchaseId` не UUID → 400;
   - ошибка сервиса `PurchaseActionUnavailableError` → 409 с её кодом.
3. **`backend/api/test/roles.test.ts`:** `payments.support` есть у `owner` и
   `admin` и нет у остальных ролей.
4. **`backend/api/test/payments-alert-notifier.test.ts`:**
   - `supportActionText` для возврата и для выдачи — строки по шагу 13 целиком;
   - два одинаковых события `onSupport` → два сообщения: дедупликации нет;
   - нет чата → не отправляет и не бросает;
   - текст о зависшей покупке (не `undeliverable`) кончается «В панели:
     карточка игрока → «Покупки».».
5. **`backend/api/test/admin-players.test.ts`:**
   - в `setup` (строка ~101) последним аргументом `new AdminPlayersService(…)`
     передать подмену `{ actionsFor: () => ["refund"] } as never`;
   - новый кейс: у админа покупка в карточке приходит с `actions: ["refund"]`,
     у геймдизайнера (выручку видит, права `payments.support` нет) — с
     `actions: []`;
   - существующие кейсы с `card.purchases` не меняются.

## Аналитика

Событий продукта нет. Возвраты и выручку аналитика считает по таблице
`purchase` (`docs/22-analytics-and-metrics.md` §5.4), причина `manual` видна
в `refund_reason`. Действия людей — в журнале действий панели.

## Настройки и окружение

Нет. Поток «Покупки» — существующий `notify.chat.payments` (T-0003).

## Документы

- `docs/29-admin-panel.md`:
  - §2, строка «Игроки» — после «история забегов и покупок» дописать
    «— у покупки можно повторить выдачу или вернуть звёзды (остаток товара
    забирается), с причиной»;
  - §3.3 — строка матрицы после «Игроки: ручное начисление и списание»:
    `| Игроки: возврат звёзд и повторная выдача покупки | И | И | | | | | | |`.
- `docs/21-diagrams.md`:
  - ER: у `refund_reason` — `test_mode|unused|external|undeliverable|manual`;
  - схема модулей: `ADMINAPI -- "возврат и выдача покупки поддержкой" --> PAY`.
- `docs/35-stage4-plan.md`, «Как сделано» WP10 — новый абзац «часть 10 —
  поддержка покупок» (`tasks/T-0037`):
  - право `payments.support`;
  - причина `manual`;
  - остаток забирается после возврата заданием очереди;
  - сообщения в поток «Покупки».

## Критерии приёмки

- [ ] Владелец и админ могут вернуть звёзды за оплаченную покупку. Если
  покупка выдана, после возврата у игрока забирается остаток.
- [ ] Владелец и админ могут повторить выдачу оплаченной невыданной покупки.
  Дважды она не выдаёт.
- [ ] Остальные роли получают 403, себе — 403, кроме входа разработчика.
- [ ] Каждое действие — с причиной от 3 до 200 символов, в журнале действий
  и сообщением в поток «Покупки».
- [ ] Карточка игрока отдаёт у покупки `actions`, без права — пустой список.
- [ ] Ручной возврат не закрывает покупки аккаунту.
- [ ] Миграция одна, в ней только значение `manual`.
- [ ] Тест подъёма приложения `app-boot.integration.test.ts` зелёный в CI.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Ручной возврат и повторная выдача покупки`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДДЕРЖКА ПОКУПОК НА СЕРВЕРЕ**

  У поддержки появились два действия с покупкой: повторить выдачу и вернуть звёзды. Кнопки в карточке игрока придут следующей задачей.

  🛟 **Как устроено**

  • право payments.support — у владельца и админа; себе нельзя, причина обязательна
  • возврат выданной покупки забирает остаток: самоцветы до того, что есть на счёте, у VIP — неиспользованную часть; забирается после того, как звёзды ушли
  • повторная выдача идёт сразу и дважды не начисляет
  • о каждом действии — сообщение в поток «Покупки» и запись в журнале действий
  ```
