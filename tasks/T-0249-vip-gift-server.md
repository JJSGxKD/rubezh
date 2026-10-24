---
id: T-0249
title: VIP в подарок другу — сервер: заказ за звёзды, срок подарка, уведомление, возврат
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0247]
zones:
  - backend/api/src/modules/vip/vip-gift.service.ts
  - backend/api/src/modules/vip/vip-gift.repository.ts
  - backend/api/src/modules/vip/vip-gift-rules.ts
  - backend/api/test/vip-gift-rules.test.ts
  - backend/api/test/vip-gift.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/vip/vip.service.ts
  - backend/api/src/modules/vip/vip.repository.ts
  - backend/api/src/modules/vip/vip.controller.ts
  - backend/api/src/modules/vip/vip.module.ts
  - backend/api/src/modules/vip/vip-plan.ts
  - backend/api/src/modules/vip/vip-errors.ts
  - backend/api/src/modules/payments/purchase-types.ts
  - backend/api/src/modules/payments/invoice-text.ts
  - backend/api/src/modules/payments/purchase-fulfillment.ts
  - backend/api/src/modules/payments/purchase-revocation.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
  - docs/37-accounting.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0249. VIP в подарок другу — сервер: заказ за звёзды, срок подарка, уведомление, возврат

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0249.json)](README.md#значки-статуса) [![T-0247](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0247.json&label=T-0247)](T-0247-player-card-server.md)

## Зачем

Купить VIP можно только себе. После задачи игрок из карточки друга
(T-0248) покупает ему VIP на 30 дней за звёзды. Друг получает VIP и
уведомление «вам подарили VIP». Возврат звёзд забирает подаренный срок.
Клиент — T-0250.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р155** — подарок другу: облик или VIP из его карточки;
- **поправка от 24.10.2026** — сейчас карточка и VIP в подарок, облик в
  подарок — вместе с Ярмаркой; **дарить можно только друзьям**: меньше
  злоупотреблений с возвратами.

Решения `claude-lead-1` от 24.10.2026:

- **Что дарится** — 30 дней VIP (`VIP_PLAN.periodDays`) разовой покупкой, не
  подпиской: продлевать за друга нельзя.
  - Цена — как месяц подписки, `VIP_PLAN.stars`; позиция `VIP_GIFT_SKU` в `vip-plan.ts`.
  - Продукт оплаты — новый `vip_gift`.
- **Срок подарка хранится отдельно от подписки** — таблица `vip_gift
  (purchase_id PK, giver_account_id, recipient_account_id, starts_at,
  ends_at, revoked_at NULL)`. Подписка и её продления продолжают писать свой
  срок и подарок не затирают.
  - Начало нового подарка — максимум из «сейчас» и конца последнего неотозванного подарка этого получателя: подарки встают в очередь.
  - **VIP активен**, если активна подписка **или** сейчас идёт неотозванный подарок. `isActive` и всё, что от него зависит, — награда дня VIP, пропуски рекламы, Князь, знак VIP, галочка — смотрят на оба. Правило — чистая функция `vipActiveAt(subscriptionUntil, gifts, at)`.
- **Заказ** — `POST /api/v1/vip/gift` с телом `{ publicId }` (Zod) → счёт
  Stars, как `order` у VIP.
  - Проверки до счёта: получатель есть и это друг (иначе 409 `vip_gift_not_friend`); не сам себе; получатель не заблокирован; у дарящего ограничение покупок не стоит.
  - Получатель записывается в заказ на сервере. Подтверждение оплаты берёт его из заказа, а не из клиента.
  - Не больше пяти заказов подарка в сутки на дарящего, лимит запросов — как у покупок.
- **Выдача** (`purchase-fulfillment.ts` → `vip-gift.service.ts`):
  - строка `vip_gift` с `ON CONFLICT (purchase_id) DO NOTHING` — повтор подтверждения ничего не меняет;
  - уведомление получателю новым видом `vip_gift` (`{ fromName, days }`, `notification-kinds.ts`), дедуп по покупке.

  Перестали дружить между оплатой и подтверждением — подарок всё равно
  выдаётся: оплачено.
- **Возврат** (`purchase-revocation.ts`): `revoked_at` у строки.
  - Не начался — срок пропадает целиком; идёт — обрывается сейчас.
  - Следующие подарки того же получателя не сдвигаются.
  - Получателю — уведомление не шлём.
- **Учёт:** покупка — обычная оплата дарящего (`docs/37`), получатель денег
  не платил. Строка в `docs/37` — чья выручка и чей срок.

## Как сейчас

- `vip/vip.service.ts`:
  - `order` (115), `fulfill` (196), `revoke` (278), `state` (331), `isActive` (361);
  - срок подписки — `until` в `vip.repository.ts` (23–109).
- `vip/vip-plan.ts:23–54` — `stars: 700`, `periodDays: 30`, `VIP_PERIOD_SEC`.
- `payments/purchase-types.ts:14` — `PurchaseProduct = "continue_run" |
  "shop_item" | "vip" | "donation"`; `payments.service.ts:162` —
  `shopInvoice`; выдача и возврат — `purchase-fulfillment.ts`,
  `purchase-revocation.ts`.
- `notifications/notification-kinds.ts:19–39` — виды уведомлений (`friend_gift`
  — образец).
- После T-0247 — `publicId` и `byPublicId`, отношение дружбы.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция:**
   - продукт `vip_gift` (тип или CHECK — как устроен `product` в базе);
   - таблица `vip_gift` с внешними ключами на `account` и покупку, индекс `(recipient_account_id, ends_at)`;
   - ER в `docs/21`.
3. **`vip-gift-rules.ts`** — `nextGiftWindow(lastEnd, at, days)`,
   `vipActiveAt(subscriptionUntil, gifts, at)`.
4. **`vip-gift.repository.ts`, `vip-gift.service.ts`** — заказ, выдача,
   возврат, подарки получателя на момент.
5. **`vip.service.ts`** — `isActive` и `activeAt` через `vipActiveAt`; метод
   списка VIP (T-0235) — тоже. Подписка и её продления не меняются.
6. **Платежи** — продукт `vip_gift`: тексты счёта (`invoice-text.ts`:
   «VIP на 30 дней в подарок — {name}»), выдача, возврат.
7. **Контроллер** — `POST /vip/gift`; ответ — счёт, как у `order`.
8. **Уведомление** — вид `vip_gift`.
9. **Очистка:** `vip_gift` — в `wipe-plan.ts` и `wipe-runner.ts`.
10. **Документы:** `docs/07` (VIP в подарок), `docs/37` (учёт), `docs/21`
    (ER).

## Чего не трогаем

- Подписку VIP и её продления.
- Облик в подарок — с Ярмаркой.
- Клиент — T-0250.

## Тесты

Первым коммитом.

- `vip-gift-rules.test.ts`:
  - подарок без VIP — с сейчас на 30 дней;
  - второй подарок — встаёт после первого;
  - `vipActiveAt`: подписка истекла, подарок идёт → активен; оба кончились → нет; отозванный подарок → не в счёт.
- `vip-gift.integration.test.ts` (живые Postgres и Redis):
  - друг → счёт; не друг → 409 `vip_gift_not_friend`; себе → 409; заблокированному → 409;
  - подтверждение → получатель VIP 30 дней, уведомление `vip_gift`; повтор подтверждения — без второго срока и второго уведомления;
  - у получателя активная подписка → подарок после конца текущего срока; продление подписки срок подарка не трогает;
  - возврат до начала → срока нет; возврат в середине → VIP обрывается сейчас; следующий подарок на месте;
  - шестой заказ за сутки → 429;
  - Князь, знак VIP и награда дня VIP у получателя работают на подаренном сроке.

## Аналитика

Оплата — существующие события `purchase_*` с `product: vip_gift`. Заказ из
карточки пишет клиент (T-0250).

## Настройки и окружение

Нет.

## Документы

По шагу 10.

## Критерии приёмки

- [ ] Игрок дарит другу 30 дней VIP за звёзды; получатель получает VIP и уведомление.
- [ ] Подарки встают в очередь и не мешают подписке; возврат забирает подаренный срок.
- [ ] Дарить можно только другу, получатель берётся из заказа на сервере.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(vip): VIP в подарок другу — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — кнопка придёт с клиентом (T-0250).
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — VIP В ПОДАРОК, СЕРВЕР**

  Игрок может купить другу 30 дней VIP за звёзды. Подарок — отдельный срок рядом с подпиской: подарки встают в очередь, продление подписки их не трогает, возврат звёзд забирает подаренное. Получатель получает уведомление. Дарить можно только друзьям.
  ```
