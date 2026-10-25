---
id: T-0326
title: «Выбор игроков» в магазине — метка у набора, который за 30 дней купило больше всего разных игроков; считается сервером, ниже порога не показывается
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/shop/shop-choice.ts
  - backend/api/test/shop-choice.test.ts
  - backend/api/test/shop-choice.integration.test.ts
shared:
  - backend/api/src/modules/shop/shop-marketing.ts
  - backend/api/src/modules/shop/shop.service.ts
  - backend/api/src/modules/shop/shop.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/test/shop.test.ts
  - packages/app-shell/src/state/shop-purchase.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - packages/app-shell/src/state/shop-api.ts
  - packages/app-shell/src/screens/meta/shop-texts.ts
  - packages/app-shell/src/i18n/ru-shop.json
  - docs/07-monetization-and-ads.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0326. «Выбор игроков» в магазине — метка у набора, который за 30 дней купило больше всего разных игроков; считается сервером, ниже порога не показывается

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0326.json)](README.md#значки-статуса)

## Зачем

На витрине самоцветов уже считаются «Лучшая цена» и «выгоднее на N %», а
выбор других игроков не виден. После задачи у набора, который за последние
30 дней купило больше всего разных игроков, — метка «Выбор игроков». Она
считается по покупкам, а не ставится руками, поэтому всегда правда.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р162: метка у самого
покупаемого набора за 30 дней, считается, а не ставится руками; ниже порога
покупателей метки нет.

Решения `claude-lead-1` от 25.10.2026:

- **Что считаем** — **разные игроки**, а не покупки: один щедрый игрок с
  двадцатью покупками не должен ставить метку сам.
- **Какие покупки:**
  - товар магазина (`product` — магазин, не второй шанс);
  - живая оплата (`mode = live`), `paid_at` за последние 30 суток;
  - звёзды не возвращены и возврат не заказан.
- **Какие наборы** — только повторяемые (`once: false`) и продающиеся
  сейчас. Стартовый набор разовый и самый выгодный — его берёт почти каждый,
  метка на нём ничего бы не говорила.
- **Порог** — ключ панели `shop.choice-min-buyers`, умолчание 20: у лидера
  меньше разных покупателей — метки нет. Ничья — у набора с меньшим `sort`.
- **Одна метка на набор**, старшинство: «Хит» команды → «Выбор игроков» →
  «Лучшая цена». Метка, уступившая место, на другой набор не переезжает.
- **Расчёт** — `shop-choice.ts`:
  - чистая `choiceOf(counts, skus, minBuyers)` → id набора или `null`;
  - запрос — один `count(DISTINCT account_id)` с `GROUP BY sku`,
    `statement_timeout`;
  - кеш в Redis `shop:players-choice` на 1 час (`SET … EX`), сбой Redis или
    базы — метки нет, витрина работает.
- **Клиент** — тип метки знает `choice`, текст `shop.badge.choice` —
  «Выбор игроков», вид — как у «Хита».

## Как сейчас

- **Метки** — `badgesOf` (`shop/shop-marketing.ts:45`): «Хит» из каталога,
  «Лучшая цена» — у набора с наибольшим числом самоцветов за звезду.
- **Каталог** — `shop-catalog.ts`: `once`, `sort`, `badge: z.enum(["hit"])`.
- **Витрина** — `shop.service.ts:105`, метка в ответе — `badge`.
- **Покупки** — модель `Purchase` (`schema.prisma:519`): `product`, `sku`,
  `mode`, `status`, `paid_at`, `refund_requested_at`, `refunded_at`.
- **Клиент** — `state/shop-api.ts:30` (`badge` — строка), тексты —
  `screens/meta/shop-texts.ts`, `i18n/ru-shop.json:14`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`shop-choice.ts`** — функция, запрос, кеш.
3. **`badgesOf`** — третий вид `choice` со старшинством.
4. **Ключ** `shop.choice-min-buyers` в `setting-catalog.ts`.
5. **Клиент** — тип и текст.
6. **Аналитика** — поле `badge` по разделу «Аналитика».
7. **Документы** — `docs/07` (метки витрины), `docs/30` (ключ), `docs/22`.

## Чего не трогаем

- Цены, выгоду и «Лучшую цену».
- «Хит» в каталоге — остаётся у команды.

## Тесты

Первым коммитом.

- `shop-choice.test.ts`:
  - лидер с 25 покупателями при пороге 20 → его id; с 19 → `null`;
  - ничья → меньший `sort`;
  - разовый набор не участвует.
- `shop.test.ts` (рядом с тестами `badgesOf`):
  - «Выбор игроков» и «Лучшая цена» на одном наборе → «Выбор игроков»,
    «Лучшая цена» не переезжает;
  - «Хит» сильнее «Выбора игроков».
- `shop-choice.integration.test.ts` (живые Postgres и Redis):
  - один игрок купил набор 30 раз → один покупатель;
  - покупка 31 день назад и покупка с возвратом не считаются;
  - тестовая оплата не считается;
  - второй запрос витрины — из кеша, без запроса в базу.

## Аналитика

`purchase_initiated` и `purchase_completed` получают необязательное `badge`
(`hit`, `choice`, `best`) — метку набора в момент покупки: так видно,
продаёт ли метка. Сначала словарь `docs/22` §3.3, потом `purchaseFields` в
Zod, потом клиент (`state/shop-purchase.ts`).

## Настройки и окружение

Ключ `shop.choice-min-buyers` (20).

## Документы

По шагу 7.

## Критерии приёмки

- [ ] У набора, который купило больше всего разных игроков за 30 дней, — метка «Выбор игроков»; ниже порога её нет.
- [ ] Разовые наборы, возвраты и тестовые оплаты не считаются; одна метка на набор.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(shop): Метка «Выбор игроков»`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: метка «Выбор игроков» у набора самоцветов, который берут чаще всего`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ВЫБОР ИГРОКОВ» В МАГАЗИНЕ**

  У набора самоцветов, который за 30 дней купило больше всего разных игроков, появляется метка «Выбор игроков». Метка считается по живым оплатам без возвратов и не показывается, пока у лидера меньше 20 покупателей (ключ shop.choice-min-buyers). «Хит» команды по-прежнему сильнее.
  ```
