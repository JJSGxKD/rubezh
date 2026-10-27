---
id: T-0309
title: Цены товаров в панели с подтверждением второго участника — заявка на правку, подтверждает другой человек с правом, правка ложится поверх каталога в коде
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0304]
zones:
  - backend/api/src/modules/change-requests/**
  - backend/api/src/modules/shop/shop-overrides.ts
  - backend/api/src/modules/admin/admin-change-requests.controller.ts
  - backend/api/test/change-requests.test.ts
  - backend/api/test/change-requests.integration.test.ts
  - apps/admin/src/api/change-requests.ts
  - apps/admin/src/screens/balance/prices/**
  - apps/admin/test/balance-prices.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/shop/shop-catalog.ts
  - backend/api/src/modules/shop/shop.service.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - apps/admin/src/screens/balance/BalanceScreen.tsx
  - docs/19-content-admin.md
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 7
---

# T-0309. Цены товаров в панели с подтверждением второго участника — заявка на правку, подтверждает другой человек с правом, правка ложится поверх каталога в коде

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0309.json)](README.md#значки-статуса) [![T-0304](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0304.json&label=T-0304)](T-0304-balance-editor-tables.md)

## Зачем

Цены магазина — каталог в коде (`shop/shop-catalog.ts`), и поменять цену в
звёздах можно только релизом. Ошибка в цене — прямой денежный эффект
(`docs/19` §6), поэтому одному человеку её не меняют. После задачи во
вкладке «Цены и награды» раздела «Баланс»:
1. один человек оформляет заявку «было → стало»;
2. другой человек с тем же правом её подтверждает;
3. только тогда цена меняется.

Механизм заявок общий: им же пойдут награды (T-0310).

## Решения

Решения владельца — 25.10.2026, опрос: в первой волне редактора — и цены и
награды. Правила — `docs/19` §6:
- цена — серверная величина;
- правка цены — с подтверждением второго участника;
- только фиксированные цены.

Решения `claude-lead-1` от 25.10.2026:

- **Заявка** — таблица `change_request`:
  - `request_id`, `kind` (`sku_price`, позже `reward_setting`), `target`
    (id товара или ключ), `before jsonb`, `after jsonb`, `reason` (до 200,
    обязательно);
  - `author`, `status` (`pending` | `approved` | `rejected` | `expired` |
    `superseded`), `decided_by`, `decided_at`, `created_at`.
- **Правила:**
  - подтверждает **не автор**, с тем же правом (`sku.price.edit`);
  - заявка живёт 72 часа, дальше — `expired`;
  - новая заявка на ту же цель гасит прежнюю (`superseded`);
  - подтверждение применяет правку одной транзакцией с условием «цель всё
    ещё равна `before`»: изменилась — 409 и заявка `superseded`.
- **Что правится у товара** — `stars`, `baseRub`, `contents.gems`, `badge`,
  `sort`. Не правится `id`, `kind`, `once`: новый товар — код.
  - Правка ложится в `shop_sku_override (sku_id, fields jsonb, set_by,
    set_at)` поверх каталога в коде.
  - `shop.service.ts` отдаёт товар с правкой, проверяя её той же
    `shopSkuSchema`.
- **Счёт игрока** — покупка, начатая до правки, оплачивается по цене
  инвойса: цена берётся из инвойса, а не перечитывается.
- **Уведомление** — новой заявке второй участник получает уведомление
  панели (`notification-kinds.ts`, вид `change_request_pending`) и сообщение
  в чат админов.
- **Панель** — вкладка «Цены и награды»:
  - товары: текущая цена, «Предложить цену»;
  - заявки: кто, «было → стало», причина, срок;
  - «Подтвердить» и «Отклонить» — у всех, кроме автора; у автора —
    «Отозвать».
- **Аудит** — заявка, подтверждение, отклонение, применение.

## Как сейчас

- **Каталог** — `shop/shop-catalog.ts` (`SHOP_SKUS`, `shopSkuSchema`, `stars`,
  `baseRub`); выдача — `shop.service.ts`.
- **Право** `sku.price.edit` есть у `game_designer`, `admin`, `owner`
  (`roles/permissions.ts`), маршрутов под него нет.
- **После T-0304** — раздел «Баланс» с вкладками.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `change_request`, `shop_sku_override`; ER в `docs/21`;
   строки в `wipe-plan.ts` (`keep`).
3. **Модуль `change-requests`** — создание, подтверждение, отклонение,
   срок, гашение; применение по виду.
4. **`shop-overrides.ts`** — правка поверх каталога.
5. **Маршруты** — `admin-change-requests.controller.ts`; уведомление.
6. **Панель** — вкладка «Цены и награды».
7. **Документы:**
   - `docs/19` §6 — как устроено подтверждение;
   - `docs/29`.

## Чего не трогаем

- Новые товары и их виды — код.
- Награды — T-0310.

## Тесты

Первым коммитом.

- `change-requests.test.ts`:
  - автор не может подтвердить;
  - заявка старше 72 ч — `expired`;
  - новая на ту же цель — прежняя `superseded`.
- `change-requests.integration.test.ts`:
  - заявка → подтверждение другим → цена товара новая;
  - цель изменилась между заявкой и подтверждением → 409;
  - правка с `stars: 0` → отказ схемой;
  - покупка, начатая до правки, — по старой цене;
  - без `sku.price.edit` — 403.
- `balance-prices.test.ts` — у автора нет «Подтвердить».

## Аналитика

Нет событий игрока: заявки — в аудите. Изменение цены видно в
`purchase_*` (цена — в событии покупки).

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Цена товара меняется в панели только заявкой и подтверждением второго участника.
- [ ] Правка — поверх каталога в коде, проверяется схемой; начатые покупки — по старой цене.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Цены с подтверждением второго участника`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЦЕНЫ С ДВОЙНЫМ ПОДТВЕРЖДЕНИЕМ**

  Цены товаров магазина меняются в панели без релиза: один предлагает «было → стало» с причиной, второй подтверждает. Автор свою заявку подтвердить не может, заявка живёт 72 часа. Вкладка «Цены и награды» в «Балансе».
  ```
