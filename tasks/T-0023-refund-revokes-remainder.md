---
id: T-0023
title: Возврат звёзд забирает то, что осталось от покупки
epic: E1
priority: P0
status: ready
owner:
size: M
depends_on: [T-0003, T-0004, T-0025]
zones:
  - backend/api/src/modules/payments/purchase-revocation.ts
  - backend/api/src/modules/payments/payment-confirmation.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/wallet/wallet.repository.ts
  - backend/api/src/modules/wallet/wallet.service.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/shop/shop.service.ts
  - backend/api/src/modules/vip/vip.service.ts
  - backend/api/src/modules/vip/vip.repository.ts
  - backend/api/src/modules/history/history-types.ts
  - packages/app-shell/src/i18n/ru-history.json
  - backend/api/test/purchase-revocation.test.ts
  - backend/api/test/payment-confirmation.test.ts
  - backend/api/test/wallet.integration.test.ts
  - backend/api/test/vip.integration.test.ts
  - backend/api/test/vip.test.ts
  - backend/api/test/shop.test.ts
  - backend/api/test/history.test.ts
shared:
  - docs/35-stage4-plan.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: xhigh
release: patch
design: null
---

# T-0023. Возврат звёзд забирает то, что осталось от покупки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0023.json)](README.md#значки-статуса) [![T-0003](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0003.json&label=T-0003)](T-0003-payments-fulfillment-sweeper.md) [![T-0004](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0004.json&label=T-0004)](T-0004-payments-refunds-via-queue.md) [![T-0025](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0025.json&label=T-0025)](T-0025-vip-no-double-subscription.md)

## Зачем

Игрок покупает самоцветы или VIP за звёзды, тратит, а потом возвращает
звёзды через Telegram — и всё купленное остаётся у него. Это пункт К4 аудита:
схема «купил → потратил → вернул» открыта. Оплата выключена, и это одна из
причин.

## Решения

- **06.10.2026, решение пользователя — забрать остаток и закрыть покупки.**
  - эта задача забирает то, что осталось от покупки;
  - закрытие покупок аккаунту и карточку команде делает T-0024.
- **Только при внешнем возврате** (`refundReason === "external"`: спор игрока
  или возврат через Telegram). Наши собственные возвраты ничего не забирают:
  - `undeliverable` — товар и не выдавался;
  - возврат лишней оплаты — товар выдан по первой оплате и остаётся.
- **Самоцветы и другие ресурсы покупки** списываются до остатка: не больше,
  чем начислила эта покупка, и не больше, чем есть на счёте. В минус баланс не
  уходит. Потраченное не возвращается.
- **VIP** — убирается неиспользованная часть периода этой оплаты, а продление
  подписки выключается. Периоды, оплаченные отдельно и стоящие в цепочке
  после этого, сдвигаются на убранное время. Общий срок VIP уменьшается ровно
  на неиспользованный остаток возвращённой оплаты.
- **Второй шанс** использован в момент покупки — забирать нечего, только
  строка «ничего».
- **Отзыв идемпотентен и повторяется при каждом вызове** обработки возврата,
  а не только в первый раз. Обработка возврата идёт через очередь оплаты
  (T-0004) и повторяется при сбое. Если первая попытка отметила возврат и
  упала на отзыве, повтор обязан его доделать.
- **Как отзыв устроен.** Каждый владелец товара регистрирует свой отзыв, как
  уже регистрирует выдачу (`PurchaseFulfillment`). Модуль оплаты не знает ни
  кошелька, ни VIP.

## Как сейчас

- **`backend/api/src/modules/payments/payment-confirmation.ts:132-153` —
  `refunded(chargeId, nowMs)`:**
  - `purchases.markRefunded(chargeId, at)` → `{ purchase, firstTime }`;
  - при `!firstTime` — выход;
  - при `external` пишет лог `warn` с `refundStats` аккаунта.

  После T-0004 этот метод зовёт задание очереди оплаты.
- **`purchases.repository.ts:359-368` — `markRefunded`:** время возврата
  ставится первым вызовом, причина `external`, если возврат заказывали не мы.
  У `StoredPurchase` есть `refundReason`, `refundedAt`, `product`, `sku`,
  `purchaseId`, `accountId`, `renewalOf` (`purchase-types.ts`).
- **Выдача товаров — `PurchaseFulfillment`** (`payments/purchase-fulfillment.ts`):
  - владелец регистрирует выдачу по виду товара в `onModuleInit`:
    `this.fulfillment.register("vip", …)` в `vip.service.ts:79`, у магазина —
    в `shop.service.ts`;
  - образец для `PurchaseRevocation`.
- **`shop.service.ts:159-173` — `fulfill`:** каждый ресурс набора начисляется
  `wallet.grant` с ключом `purchase:<purchaseId>:<resource>`.
- **Кошелёк:**
  - `wallet-ledger.ts:70-100` — `debitWithin`: списание строкой журнала с
    ключом и `UPDATE wallet_balance … AND balance >= amount`;
  - `wallet.repository.ts:198-204` — запись журнала по ключу (`existing`);
  - `wallet.repository.ts:206-209` — баланс (`balanceOf`);
  - причины — `wallet-types.ts:40-60`, колонка `reason` в базе — `VarChar(32)`,
    без перечисления в схеме, миграция не нужна.
- **VIP:**
  - периоды — `vip_period`: `purchase_id`, `subscription_id`, `account_id`,
    `starts_at`, `ends_at`;
  - цепочка периодов строится в `vip.repository.ts:126-150` (`addPeriod`)
    под `pg_advisory_xact_lock(hashtext('vip:<accountId>'))`;
  - продление — `setRenewal` (строка 72) и `this.renewal.set(account, subscriptionId, false)`,
    как в `cancel` (`vip.service.ts:132-142`). После T-0025 в `VipService`
    уже есть `accounts` (`ACCOUNT_REPOSITORY`).
- **История имущества:** `history/history-types.ts:52` —
  `PURCHASE_REASONS = new Set(["purchase", "shop"])`. Подписи причин —
  `packages/app-shell/src/i18n/ru-history.json`, ключи `history.reason.<причина>`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Новый `payments/purchase-revocation.ts`:**

   ```ts
   /** Что забрано при возврате — строками для лога и карточки команде: «самоцветы: 120 из 150». */
   export interface Revocation {
     lines: string[];
   }

   export type Revoker = (purchase: StoredPurchase, at: Date) => Promise<Revocation>;

   @Injectable()
   export class PurchaseRevocation {
     register(product: PurchaseProduct, revoker: Revoker): void;
     /** Владельца нет — забирать нечего: `{ lines: ["ничего — товар не забирается"] }`. */
     revoke(purchase: StoredPurchase, at: Date): Promise<Revocation>;
   }
   ```

   Повторная регистрация того же вида — ошибка `Error("отзыв <вид> уже зарегистрирован")`.
   У `PurchaseFulfillment` такой проверки нет (`set` в `Map`), а здесь она
   нужна: два отзыва одного товара забрали бы дважды. Провайдер и экспорт — в
   `payments.module.ts`.
3. **Кошелёк — `revokeUpTo`.**
   - `wallet-types.ts`: `export const REVOKE_REASON = "refund_revoke";`, в
     `WalletReason` — `| typeof REVOKE_REASON`.
   - `wallet.repository.ts` — новый метод интерфейса и реализации, одной
     транзакцией с `TX_OPTIONS`:

     ```ts
     /**
      * Забрать начисленное записью `grantKey` — не больше её суммы и не больше
      * баланса. `nothing` — такой записи нет или забирать нечего; `duplicate` —
      * ключ уже был, в ответе забранное тогда.
      */
     revokeUpTo(input: { accountId: string; resource: WalletResource; grantKey: string; idempotencyKey: string; source: string | null; at: Date }):
       Promise<{ status: "revoked"; revoked: number; granted: number; balance: number } | { status: "duplicate"; revoked: number; granted: number } | { status: "nothing"; granted: number }>;
     ```

     Порядок внутри транзакции:
     1. строка баланса `SELECT balance FROM wallet_balance WHERE account_id = … AND resource = … FOR UPDATE`;
        строки нет — баланс 0;
     2. запись с `idempotencyKey` уже есть → `duplicate` с `revoked = -amount`
        этой записи. `granted` — сумма записи `grantKey`, 0, если её нет;
     3. записи `grantKey` нет или её сумма ≤ 0 → `nothing`, `granted: 0`;
     4. `take = min(granted, balance)`; `take === 0` → `nothing` с `granted`,
        запись не создаётся;
     5. `INSERT INTO wallet_entry … amount = -take, reason = 'refund_revoke', idempotency_key = …`
        и `UPDATE wallet_balance SET balance = balance - take …`.

     Потолков и суточных счётчиков отзыв не касается.
   - `wallet.service.ts` — `revokeUpTo(input)` проверяет ключи (`checkKey`) и
     зовёт репозиторий. Лог `warn` `wallet_revoked` с полями `accountId`,
     `resource`, `revoked`, `granted` — только при `revoked`.
4. **Магазин — отзыв `shop_item`.** В `shop.service.ts`, `onModuleInit`
   рядом с регистрацией выдачи:

   ```ts
   this.revocation.register("shop_item", (purchase, at) => this.revoke(purchase, at));
   ```

   `revoke`: для каждого ресурса из `WALLET_RESOURCES` —
   `wallet.revokeUpTo({ grantKey: \`purchase:${id}:${resource}\`, idempotencyKey: \`refund:${id}:${resource}\`, source: \`shop:${sku}\`, … })`.
   Ресурсы берутся все, а не из каталога: товар мог уйти из каталога после
   покупки, а ключи начисления остались. Строки результата:
   - `«<resource>: <revoked> из <granted>»` — для каждого ресурса с `granted > 0`;
   - ни одного такого — `["ничего — начислений покупки нет"]`.
5. **VIP — отзыв `vip`.**
   - `vip.repository.ts` — новый метод:

     ```ts
     /**
      * Убрать неиспользованный остаток периода оплаты `purchaseId` к моменту `at`:
      * конец периода — не позже `max(starts_at, at)`, а периоды аккаунта после него
      * сдвигаются на убранное время. `null` — периода нет.
      */
     cutPeriod(purchaseId: string, at: Date): Promise<{ subscriptionId: string; removedSec: number; until: Date | null } | null>;
     ```

     Одна транзакция под тем же advisory-локом `vip:<accountId>`, что
     `addPeriod`. `accountId` и `subscriptionId` — из строки периода:
     1. `cut = ends_at - GREATEST(starts_at, at)`. Если `cut ≤ 0` — ничего не
        менять, `removedSec: 0`;
     2. у периода `ends_at = ends_at - cut`;
     3. у периодов того же аккаунта с `starts_at >= <старый ends_at>`:
        `starts_at - cut`, `ends_at - cut`;
     4. `until` — новый `max(ends_at)` аккаунта.

     Повторный вызов даёт `cut = 0`: метод идемпотентен.
   - `vip.service.ts`, `onModuleInit` — `this.revocation.register("vip", (purchase, at) => this.revoke(purchase, at))`.
     `revoke`:
     1. `repository.cutPeriod(purchase.purchaseId, at)`. `null` →
        `["VIP: периода нет"]`;
     2. продление подписки `subscriptionId` выключить:
        - `accounts.byId(purchase.accountId)`;
        - `renewal.set(accountRef, subscriptionId, false)`: ошибку площадки —
          в лог `warn` и дальше, отказ (`rejected`) — тоже дальше: продления
          там уже нет;
        - `repository.setRenewal(subscriptionId, "cancelled", "game", at)`;
     3. строки:
        - `«VIP: убрано <N> ч, теперь до <until UTC ГГГГ-ММ-ДД ЧЧ:ММ>»`, или
          `«…, VIP закончился»`, если `until` в прошлом;
        - если `removedSec === 0` — `«VIP: период уже использован»`;
        - всегда `«продление выключено»`.
6. **`payment-confirmation.ts`, `refunded`:**
   - зависимость `PurchaseRevocation`;
   - после `markRefunded`, если `record !== null` и
     `record.purchase.refundReason === "external"` — **при каждом вызове**, до
     проверки `firstTime`:
     `const revocation = await this.revocation.revoke(record.purchase, record.purchase.refundedAt ?? new Date(nowMs))`.
     Ошибка отзыва бросается дальше: задание очереди повторит обработку;
   - лог `payment_refunded` остаётся только при `firstTime`, получает поле
     `revoked: revocation.lines`;
   - второй шанс (`continue_run`) отдельно не регистрируется: срабатывает
     ответ «владельца нет».
7. **История имущества:**
   - `history-types.ts`: `PURCHASE_REASONS` += `"refund_revoke"`;
   - `ru-history.json`: `"history.reason.refund_revoke": "Возврат звёзд за покупку"`.
8. **Документы** — раздел «Документы».

## Чего не трогаем

- Закрытие покупок аккаунту, ограничение «Покупки» и карточку команде — это
  T-0024.
- Наши возвраты (`undeliverable`, лишняя оплата) — они ничего не забирают.
- Предметы и улучшения, купленные за самоцветы до возврата: потраченное не
  возвращается.
- `markRefunded` и `refundStats`.

## Тесты

Первым коммитом.

- **`backend/api/test/wallet.integration.test.ts`**, живой Postgres, `revokeUpTo`:
  - начислено 150, баланс 200 → забрано 150, баланс 50, в журнале строка
    `-150` `refund_revoke`;
  - начислено 150, баланс 40 → забрано 40, баланс 0;
  - повтор тем же ключом → `duplicate`, `revoked: 40`, баланс не изменился;
  - записи начисления нет → `nothing`, журнал не тронут;
  - баланс 0 → `nothing`, строка журнала не создана;
  - два параллельных вызова одним ключом → одна строка журнала, баланс
    уменьшен один раз;
  - два параллельных вызова разными ключами при балансе 100 и начислениях
    по 80 → суммарно забрано не больше 100, баланс не ниже 0.
- **`backend/api/test/vip.integration.test.ts`**, живой Postgres, `cutPeriod`:
  - один период 30 суток, возврат через 10 суток → конец = момент возврата,
    `removedSec` = 20 суток;
  - два периода подряд, возврат первого через 10 суток → первый кончается в
    момент возврата, второй сдвинут на 20 суток раньше, `until` уменьшился на
    20 суток;
  - возврат второго, ещё не начавшегося → второй нулевой длины, `removedSec`
    = 30 суток;
  - повтор → `removedSec: 0`, даты не изменились;
  - периода нет → `null`.
- **`backend/api/test/purchase-revocation.test.ts`**:
  - зарегистрированный отзыв вызывается с покупкой и моментом;
  - вида без отзыва → строка «ничего…»;
  - повторная регистрация → ошибка.
- **`backend/api/test/payment-confirmation.test.ts`**, `refunded`:
  - внешний возврат, первый вызов → отзыв вызван, лог с `revoked`;
  - внешний возврат, повторный вызов (`firstTime: false`) → отзыв вызван снова;
  - наш возврат (`undeliverable`) → отзыв не вызван;
  - возврат без совпадения → отзыв не вызван;
  - отзыв бросил → `refunded` бросает.
- **`backend/api/test/shop.test.ts`** — отзыв набора на подменённом кошельке:
  ключи `purchase:<id>:gems` и `refund:<id>:gems`, строки результата.
- **`backend/api/test/vip.test.ts`** — отзыв VIP:
  - `cutPeriod` вызван;
  - `renewal.set(…, false)` и `setRenewal(…, "cancelled", "game")` вызваны;
  - отказ площадки не роняет отзыв.
- **`backend/api/test/history.test.ts`** — `walletCategory("refund_revoke") === "purchases"`.

## Аналитика

Новых событий словаря нет. Отзыв пишется в лог: `payment_refunded` с полем
`revoked`, `wallet_revoked` у кошелька. Карточку команде добавит T-0024.

## Настройки и окружение

Нет. Миграции нет: `reason` в журнале — строка.

## Документы

- `docs/35-stage4-plan.md`, «Как сделано, часть 1» магазина, пункт «**Не
  сделано и почему:** возврат по спору игрока выданное не забирает…» (около
  строки 1795) — заменить на: «Внешний возврат забирает остаток (T-0023):
  ресурсы покупки — до баланса, у VIP — неиспользованный остаток периода с
  выключением продления; закрытие покупок — T-0024 (решение 06.10.2026)».
- `docs/21-diagrams.md` — к потоку возврата, если он есть (поиск
  `refunded_payment`), добавить шаг «отзыв остатка владельцем товара». Если
  потока нет — новый раздел «4.24 Внешний возврат звёзд (этап 4)»:
  sequence-диаграмма «Telegram → очередь оплаты → `PaymentConfirmation.refunded` →
  `markRefunded` → `PurchaseRevocation` → кошелёк или VIP».

## Критерии приёмки

- [ ] Внешний возврат набора самоцветов списывает не больше начисленного и не
  больше баланса, баланс не уходит в минус.
- [ ] Внешний возврат VIP убирает неиспользованный остаток, сдвигает
  следующие периоды и выключает продление.
- [ ] Повтор обработки возврата ничего не списывает второй раз и доделывает
  отзыв, если первая попытка упала.
- [ ] Наши возвраты ничего не забирают.
- [ ] В истории имущества списание видно как «Возврат звёзд за покупку» в
  разделе покупок.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные, интеграционные тесты в
  CI на живых Postgres и Redis зелёные.

## PR

- **Заголовок:** `fix(payments): Возврат звёзд забирает остаток покупки`
- **Метка:** `release: patch`
- **Для игроков:** `- изменено [telegram]: Если вернуть звёзды за покупку, неиспользованное из неё забирается.`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВОЗВРАТ ЗВЁЗД ЗАБИРАЕТ ОСТАТОК**

  Закрыта схема «купил → потратил → вернул звёзды»: если игрок вернул звёзды через Telegram, из покупки забирается то, что от неё осталось.

  💳 **Что забирается**

  • самоцветы и другие ресурсы покупки — не больше начисленного и не больше, чем есть на счёте; в минус баланс не уходит
  • VIP — неиспользованный остаток оплаченного периода, продление выключается
  • повтор обработки ничего не списывает дважды; наши собственные возвраты ничего не забирают
  ```
