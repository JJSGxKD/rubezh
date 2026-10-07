---
id: T-0024
title: После возврата звёзд покупки аккаунту закрыты, команда получает карточку
epic: E1
priority: P0
status: ready
owner:
size: M
depends_on: [T-0023]
zones:
  - backend/api/src/modules/restrictions/restriction-catalog.ts
  - backend/api/src/modules/restrictions/restrictions.service.ts
  - backend/api/src/modules/payments/payment-confirmation.ts
  - backend/api/src/modules/payments/checkout-answer.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/shop/shop.service.ts
  - backend/api/src/modules/shop/shop.module.ts
  - backend/api/src/modules/vip/vip.service.ts
  - backend/api/src/modules/vip/vip.module.ts
  - backend/api/src/modules/admin-notify/payments-alert-notifier.ts
  - packages/app-shell/src/screens/meta/shop.tsx
  - backend/api/test/restrictions.test.ts
  - backend/api/test/payment-confirmation.test.ts
  - backend/api/test/payments-alert-notifier.test.ts
  - backend/api/test/shop.test.ts
  - backend/api/test/vip.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - docs/29-admin-panel.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
---

# T-0024. После возврата звёзд покупки аккаунту закрыты, команда получает карточку

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0024.json)](README.md#значки-статуса) [![T-0023](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0023.json&label=T-0023)](T-0023-refund-revokes-remainder.md)

## Зачем

T-0023 забирает остаток покупки при внешнем возврате звёзд. Но аккаунт может
повторять схему: купил, потратил, вернул. Пользователь решил 06.10.2026: после
такого возврата покупки аккаунту закрываются до разбора командой, а команда
узнаёт об этом сразу, карточкой в чате.

## Решения

- **Новый вид ограничения «Покупки» (`purchases`)** в каталоге ограничений
  (`docs/35-stage4-plan.md` Р75). Что он закрывает:
  - магазин и VIP не выставляют счета;
  - предварительная проверка оплаты отказывает по старым счетам.

  Купленное раньше остаётся у игрока, продления не трогаются. Право — как у
  остальных видов, `players.restrict`. Молча не накладывается: игрок всё
  равно упрётся в отказ.
- **Новая причина-шаблон «Возврат оплаты»** (`payment_refund`). Игрок видит
  текст «Возврат звёзд за покупку».
- **Накладывает система, а не человек.** После каждого первого внешнего
  возврата ограничение ставится бессрочно, с сообщением игроку (`notify: true`):
  - кто наложил — `null`, в журнале аудита `actorAccountId: null`;
  - снять его можно в панели, как любое ограничение, — правом
    `players.restrict`.

  Повторный возврат того же аккаунта заменяет ограничение тем же — так уже
  устроено наложение.
- **Карточка команде** — в поток «Покупки» (`notify.chat.payments`, T-0003).
  Одна на возврат, с дедупликацией по покупке.

## Как сейчас

- `restrictions/restriction-catalog.ts`:
  - `RESTRICTION_KINDS` — строка 16;
  - `RESTRICTION_CATALOG` с полями `title`, `effect`, `checkedIn`,
    `permission`, `silentAllowed`;
  - `RESTRICTION_REASONS` — шаблоны `{ title, player }`.

  Контрактный тест `backend/api/test/restrictions.test.ts:448-466` требует,
  чтобы каждый модуль из `checkedIn` содержал `AccountRestrictions` и строку
  `"<вид>"`.
- `restrictions/restrictions.service.ts:75-100` — `impose(actor, accountId, input, at)`:
  - права, запрет на себя, сроки;
  - `repository.impose(rows, at)`, `markSettled(replaced)`, `gate.forget`,
    `hooks.emitImposed`;
  - аудит `players.restrict`.

  В схеме `imposedBy` — `String?`, комментарий «`null` — перенесено из прежней
  блокировки» (`prisma/schema.prisma:1517`).
- Проверка в модуле — `AccountRestrictions.ensure(accountId, kind, at)`:
  бросает `AccountRestrictedError` (код `account_restricted`, 403) с текстом
  шаблона. Пример — `promo-codes.service.ts:136`. Для проверки без броска —
  `status(accountId, kind, at)` → строка или `null`
  (`account-restrictions.ts:56`). `RestrictionsModule` не глобальный,
  модули его импортируют.
- Выставление счетов — `ShopService.order` (`shop/shop.service.ts`) и
  `VipService.order` (`vip/vip.service.ts:107-124`).
- Предварительная проверка — `payment-confirmation.ts`, приватный `decide`:
  читает `checkout` и зовёт чистую `decideCheckout(view, query, nowMs, enabled)`
  (`checkout-answer.ts`). Продление подписки проходит раньше остальных
  проверок. После T-0025 там есть `subscription_active`.
- Возврат — `PaymentConfirmation.refunded`. После T-0023 он забирает остаток
  через `PurchaseRevocation` и знает `firstTime` и `revocation.lines`.
- Хуки оплаты — `payments-hooks.ts`: `onPaid`, `onSubscriptionChanged`,
  `onStuck` (T-0003).
- Уведомитель — `admin-notify/payments-alert-notifier.ts` (T-0003):
  - подписка на `onStuck`;
  - дедупликация в Redis;
  - отправка в `targets.chats().payments`.
- Клиент:
  - `packages/app-shell/src/screens/meta/shop.tsx`: `purchase(...)` → `buy(...)`
    → `noticeOf(outcome, name)`. Отказ сервера приходит как
    `{ kind: "refused", code }`;
  - плашка ограничения — `screens/meta/restricted-plaque.tsx`
    (`RestrictedPlaque kinds={…}`);
  - проверка отказа — `recheckRestriction(kinds)`, `useRestricted(kinds)` в
    `state/restrictions.ts`;
  - образец — колесо (`screens/meta/wheel.tsx:87`, `:111-113`, `:229`).

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **`restriction-catalog.ts`:**
   - `RESTRICTION_KINDS` — `"purchases"` перед `"all"`;
   - в каталоге:

     ```ts
     purchases: {
       title: "Покупки",
       effect: "Покупки за звёзды закрыты: магазин и VIP не выставляют счета, по старым счетам оплата не проходит. Купленное раньше остаётся. Ставится само после возврата звёзд через Telegram.",
       checkedIn: "shop, vip, payments",
       permission: "players.restrict",
       silentAllowed: false,
     },
     ```

   - в `RESTRICTION_REASONS`:
     `payment_refund: { title: "Возврат оплаты", player: "Возврат звёзд за покупку" }`.
3. **`restrictions.service.ts`** — новый метод:

   ```ts
   /** Наложить от имени системы — без права и без автора: решение принял не модератор, а правило (возврат оплаты). Бессрочно, с сообщением игроку. */
   async imposeBySystem(accountId: string, kind: RestrictionKind, reason: RestrictionReason, comment: string, at = new Date()): Promise<void>;
   ```

   Делает то же, что `impose` после проверок:
   - строка с `endsAt: null`, `notify: true`, `imposedBy: null`;
   - `repository.impose`, `markSettled(replaced)`, `gate.forget`, `hooks.emitImposed`;
   - аудит `players.restrict` с `actorAccountId: null`.

   Для `kind === "all"` — ошибка: систему блокировать целиком не просим. В
   `schema.prisma` поправить только комментарий у `imposedBy`: «`null` — система
   (возврат оплаты) или перенос из прежней блокировки». Миграции нет: меняется
   только комментарий.
4. **Проверки «Покупки»:**
   - `ShopService.order` и `VipService.order` — первой строкой
     `await this.restrictions.ensure(account.accountId, "purchases", at)`.
     `RestrictionsModule` — в `imports` у `shop.module.ts` и `vip.module.ts`;
   - `checkout-answer.ts`:
     - `CheckoutRefusal` += `"purchases_closed"`;
     - текст отказа: `"Покупки для этого аккаунта закрыты — подробности в игре."`;
     - `decideCheckout(view, query, nowMs, enabled, purchasesClosed = false)` —
       новый последний параметр. Отказ `purchases_closed` — сразу после
       продления (`isRenewal`), перед `already_paid`;
   - `payment-confirmation.ts`, `decide`: после чтения `checkout` —
     `purchasesClosed = (await withTimeout(this.restrictions.status(view.purchase.accountId, "purchases", new Date(nowMs)), CHECKOUT_READ_TIMEOUT_MS, "ограничения для проверки оплаты")) !== null`.
     Ошибку обрабатывать так же, как ошибку чтения покупки рядом.
     `RestrictionsModule` — в `imports` у `payments.module.ts`. Если это даёт
     циклический импорт модулей, остановиться и задать вопрос тимлидам.
5. **`payments-hooks.ts`** — хук внешнего возврата:

   ```ts
   export interface ExternalRefund {
     purchase: StoredPurchase;
     /** что забрал T-0023 */
     revoked: string[];
     stats: { paid: number; refunded: number };
     at: Date;
   }
   onExternalRefund(name: string, listener: (refund: ExternalRefund) => Promise<void>): void;
   emitExternalRefund(refund: ExternalRefund): Promise<void>;
   ```

   Устроен как соседние `on…`/`emit…`: ошибка слушателя пишется в лог и не
   роняет остальных.
6. **`payment-confirmation.ts`, `refunded`** — при `external` и `firstTime`,
   после отзыва T-0023:
   1. `await this.restrictions.imposeBySystem(accountId, "purchases", "payment_refund", "Возврат звёзд за покупку <purchaseId>", at)`.
      Ошибка бросается дальше: задание очереди повторит обработку. Отзыв на
      повторе ничего не спишет дважды (T-0023), а наложение того же вида
      заменит строку;
   2. `await this.hooks.emitExternalRefund({ purchase, revoked: revocation.lines, stats, at })`,
      `stats` — уже прочитанные `refundStats`.
7. **`payments-alert-notifier.ts`** — подписка `onExternalRefund`:
   - дедупликация `SET payments:refund-alert:<purchaseId> 1 EX 604800 NX`;
   - отправка в `targets.chats().payments`;
   - нет чата или Redis — в лог и дальше, как у карточки о невыдаче.

   Текст:

   ```
   ↩️ Возврат звёзд
   Товар: <sku или product>, <chargedStars> ⭐
   Аккаунт: <accountId>
   Оплачена: <paidAt UTC, ГГГГ-ММ-ДД ЧЧ:ММ>, возвращена: <at UTC, ГГГГ-ММ-ДД ЧЧ:ММ>
   Забрано: <revoked через «; »>
   Возвратов у аккаунта: <stats.refunded> из <stats.paid> оплат
   Покупки аккаунту закрыты — снять ограничение можно в панели.
   ```

8. **Клиент, `shop.tsx`:**
   - `const purchasesClosed = useRestricted(["purchases"])`;
   - кнопки покупки набора и VIP недоступны, пока `purchasesClosed`;
   - над витриной — `<RestrictedPlaque kinds={["purchases"]} />`, пока
     `purchasesClosed`;
   - в `purchase`: исход `refused` с `code === "account_restricted"` →
     `await recheckRestriction(["purchases"])`, общего «не получилось» не
     показывать — плашку покажет `useRestricted`;
   - константа вида — рядом с компонентом, как `AD_RESTRICTION` у колеса.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Отзыв остатка — T-0023.
- Продления действующих подписок: их выключает отзыв VIP (T-0023).
- Наложение и снятие ограничений из панели: новый вид панель показывает сама
  из каталога (`kinds` в ответе `RestrictionsService`).
- Наши возвраты (`undeliverable`, лишняя оплата): ограничения не ставят.

## Тесты

Первым коммитом.

- `backend/api/test/restrictions.test.ts`:
  - контракт каталога для `purchases` проходит: `shop`, `vip`, `payments` —
    с проверкой;
  - `imposeBySystem` → строка с `imposedBy: null`, `endsAt: null`,
    `notify: true`, аудит с `actorAccountId: null`, хук `emitImposed` вызван;
  - `imposeBySystem` с `"all"` → ошибка;
  - повторный `imposeBySystem` того же вида → прежняя строка заменена, а не
    вторая действующая.
- `backend/api/test/payment-confirmation.test.ts`:
  - `decideCheckout(..., purchasesClosed: true)` на обычном счёте →
    `purchases_closed`;
  - на продлении → `{ ok: true }`;
  - без параметра → прежнее поведение, все старые кейсы зелёные;
  - `refunded`, внешний, первый раз → `imposeBySystem(accountId, "purchases", "payment_refund", …)`
    и `emitExternalRefund` с `revoked` и `stats`;
  - внешний, повтор → ни наложения, ни хука;
  - наш возврат → ни наложения, ни хука;
  - `imposeBySystem` бросил → `refunded` бросает.
- `backend/api/test/payments-alert-notifier.test.ts`:
  - внешний возврат → одно сообщение с текстом из шага 7;
  - повтор той же покупки → сообщения нет;
  - нет чата → не бросает.
- `backend/api/test/shop.test.ts` и `backend/api/test/vip.test.ts`:
  - `order` при ограничении `purchases` → `AccountRestrictedError`;
  - счёт не выставлен.

Клиент — снимок витрины с плашкой «Покупки» на 390 px в PR.

## Аналитика

Нет новых событий словаря. Отказ ограничения уже пишется
(`restriction_refused` в `AccountRestrictions.ensure`). Наложение видно в
журнале аудита и в карточке.

## Настройки и окружение

Нет. Поток «Покупки» — `notify.chat.payments` из T-0003.

## Документы

- `docs/29-admin-panel.md` §3.4, пункт «Наказание по мере проступка» —
  дописать: «Одно ограничение ставит система: «Покупки» после внешнего
  возврата звёзд — бессрочно, с причиной «Возврат оплаты»; снимает человек в
  панели (T-0024)».
- `docs/35-stage4-plan.md`, строки 293–294 «О4 (аккаунты, которые возвращают
  звёзды)» — дописать: «— решено 06.10.2026: остаток забирается (T-0023),
  покупки закрываются до разбора (T-0024)».

## Критерии приёмки

- [ ] После первого внешнего возврата у аккаунта бессрочное ограничение
  «Покупки» с причиной «Возврат оплаты», в журнале аудита — от системы.
- [ ] С ограничением магазин и VIP не выставляют счёт, а проверка оплаты
  отказывает по старому счёту. Продление подписки проходит.
- [ ] В чате команды — одна карточка «↩️ Возврат звёзд» на возврат.
- [ ] В игре витрина показывает плашку, кнопки покупки недоступны.
- [ ] Снятие ограничения в панели снова открывает покупки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): После возврата звёзд покупки закрыты`
- **Метка:** `release: minor`
- **Для игроков:** `- изменено [telegram]: После возврата звёзд через Telegram покупки в игре закрываются до проверки командой.`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОСЛЕ ВОЗВРАТА ЗВЁЗД ПОКУПКИ ЗАКРЫТЫ**

  Если игрок вернул звёзды через Telegram, покупки ему закрываются до разбора, а команда сразу получает карточку. Вместе с T-0023 это закрывает схему «купил → потратил → вернул».

  💳 **Что изменилось**

  • новый вид ограничения «Покупки»: магазин и VIP не выставляют счета, по старым счетам оплата не проходит
  • ставит его система после первого внешнего возврата, бессрочно; снимают в панели
  • карточка «↩️ Возврат звёзд» в поток «Покупки»: что забрано и сколько возвратов у аккаунта

  ❓ **Нужно от команды**

  • @участник1 — решать по карточкам, снимать ли ограничение; правило — после первых случаев
  ```
