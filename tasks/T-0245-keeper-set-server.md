---
id: T-0245
title: «Набор хранителя» — сервер: 48 часов после первой победы над Рубежом, окрас и самоцветы
epic: E1
priority: P2
status: draft
owner:
author: claude-lead-1
size: M
depends_on: [T-0237, T-0121]
zones:
  - backend/api/src/modules/shop/keeper-set.ts
  - backend/api/src/modules/appearance/appearance-grants.repository.ts
  - backend/api/test/keeper-set.test.ts
  - backend/api/test/keeper-set.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/shop/shop-catalog.ts
  - backend/api/src/modules/shop/shop.service.ts
  - backend/api/src/modules/shop/shop.module.ts
  - backend/api/src/modules/appearance/appearance-catalog.ts
  - backend/api/src/modules/appearance/appearance-rules.ts
  - backend/api/src/modules/appearance/appearance.repository.ts
  - backend/api/src/modules/appearance/appearance.module.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0245. «Набор хранителя» — сервер: 48 часов после первой победы над Рубежом, окрас и самоцветы

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0245.json)](README.md#значки-статуса) [![T-0237](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0237.json&label=T-0237)](T-0237-appearance-server.md) [![T-0121](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0121.json&label=T-0121)](T-0121-rubezh-win-reward-server.md)

> **Черновик до облика.** Окрас «Хранитель · рассвет» продаётся, а за деньги —
> только видное до покупки (Р11). Задача переходит в `ready`, когда дизайнер
> сдаст его кадры и портреты (`design/art/backlog.md`, п. 12).

## Зачем

Самый сильный момент интереса — сразу после первой победы над Рубежом. После
задачи у игрока на 48 часов появляется «Набор хранителя»: окрас «Хранитель ·
рассвет», который иначе не получить, и 330 самоцветов за 250 звёзд — по цене
одного пакета самоцветов. Через 48 часов набор уходит навсегда. Клиент —
T-0246.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р155: «Набор хранителя» после
первой победы — окрас и самоцветы на 48 часов. Поправка от 24.10.2026:
**без зачёркнутой цены — «только 48 часов»**. Набор стоит как пакет 330
самоцветов, а окрас идёт в подарок. Зачёркнутая цена у нас обязана быть
настоящей (`shop/shop-promo-rules.ts`), а постоянной полки у набора нет.

Решения `claude-lead-1` от 24.10.2026:

- **Позиция каталога** `keeper_set`:
  - вид `bundle`, `once: true`;
  - 250 звёзд, содержимое — `{ gems: 330, appearance: "dawn" }`;
  - название «Набор хранителя».

  У содержимого появляется необязательное поле `appearance` — id облика из
  каталога T-0237.
- **Окно** — 48 часов с момента первого забега с `rubezh_reached = true`
  (T-0121). Чистая функция `keeperSetWindow(firstWinAt, at)` →
  `{ open: boolean; until: Date | null }`. Вне окна позиции нет ни в
  витрине, ни в заказе: `order` — 404 `sku_not_found`, как у несуществующей.
  Оплатил внутри окна, а подтверждение пришло позже — выдача идёт, окно
  проверяется на заказе.
- **Облик `dawn`** — в каталоге T-0237:
  - архетип `keeper`, редкость `rare`;
  - источник `{ kind: "purchase", sku: "keeper_set" }`, название «Хранитель · рассвет».
- **Выданное хранится:** первый облик с разовым источником. Таблица
  `appearance_grant (account_id, appearance_id, source, purchase_id NULL,
  granted_at)`, ключ `(account_id, appearance_id)`. `heldAppearances`
  (T-0237) учитывает её строки.
- **Выдача** — в `shop.service.ts`, `fulfill`: самоцветы — как сейчас,
  облик — строкой `appearance_grant` с `ON CONFLICT DO NOTHING` (повтор
  подтверждения ничего не меняет).
- **Возврат** (`revoke`): самоцветы — как сейчас, строка облика удаляется.
  Надет был — действующим станет `keeper` по правилу T-0237.

## Как сейчас

- `shop/shop-catalog.ts:55–100` — `starter` (150 самоцветов за 50 звёзд, `once`), `gems_60` (50 звёзд), `gems_330` (250), `gems_700` (500). Виды — `SHOP_KINDS = ["gems", "bundle", "starter"]`, содержимое — `contentsSchema` (`gems`).
- `shop/shop.service.ts:96–200`:
  - `view` (позиции `once` уже купленные — скрыты);
  - `order` → `payments.shopInvoice`;
  - `fulfill`, `revoke`.
- После T-0121 — `runs.rubezh_reached`. После T-0237 — каталог обликов и
  `heldAppearances` без таблицы выдач.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция:** таблица `appearance_grant`, внешние ключи на `account`
   (`ON DELETE CASCADE`) и на покупку, ER в `docs/21`.
3. **`appearance-catalog.ts`** — `dawn`, источник `purchase`;
   **`appearance-rules.ts`** — `grants` во входе `heldAppearances`;
   **`appearance-grants.repository.ts`** — чтение на список аккаунтов,
   вставка, удаление по покупке.
4. **`keeper-set.ts`** — `keeperSetWindow`, константы `KEEPER_SET_HOURS =
   48`, `KEEPER_SET_SKU`.
5. **`shop-catalog.ts`** — позиция, `appearance` в `contentsSchema`.
6. **`shop.service.ts`** — окно в `view` и `order` (первая победа — один
   запрос: минимальное `finished_at` забега с `rubezh_reached`), `until` в
   позиции витрины, выдача и возврат облика.
7. **Очистка:** `appearance_grant` в `wipe-plan.ts` и `wipe-runner.ts`.
8. **Документы:** `docs/07` — набор, окно, почему без зачёркнутой цены;
   `docs/21` — ER.

## Чего не трогаем

- Акции магазина (`shop-promo-*`) — набор не акция.
- Ярмарку и продажу обликов за самоцветы (Р154).
- Клиент — T-0246.

## Тесты

Первым коммитом.

- `keeper-set.test.ts`:
  - победы нет → окно закрыто;
  - через 47 ч 59 мин → открыто, `until` = победа + 48 ч;
  - через 48 ч → закрыто.
- `keeper-set.integration.test.ts` (живые Postgres и Redis):
  - первая победа → витрина несёт `keeper_set` с `until`;
  - через 49 ч → позиции нет, `order` → 404;
  - оплата → +330 самоцветов и облик `dawn` в `GET /appearance` (`held: true`);
  - повтор подтверждения → без второго начисления;
  - купленный набор в витрине больше не виден (`once`);
  - возврат → самоцветы списаны по правилам возврата, облика нет; надетый `dawn` → действующий `keeper`;
  - вторая победа окно не продлевает.

## Аналитика

Покупка — существующие события оплаты (`purchase_*`) с `sku: keeper_set`.
Показ набора в витрине пишет клиент (T-0246).

## Настройки и окружение

Нет: 48 часов и цена — в коде, рядом с каталогом.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] «Набор хранителя» виден и продаётся 48 часов после первой победы и никогда больше.
- [ ] Оплата выдаёт 330 самоцветов и облик «Хранитель · рассвет»; возврат забирает оба.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(shop): Набор хранителя — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — карточка придёт с клиентом (T-0246).
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАБОР ХРАНИТЕЛЯ, СЕРВЕР**

  После первой победы над Рубежом у игрока на 48 часов — «Набор хранителя»: 330 самоцветов и окрас «Хранитель · рассвет» за 250 звёзд, по цене пакета самоцветов. Через 48 часов набор уходит навсегда; зачёркнутой цены нет. Облики из покупок теперь хранятся (appearance_grant).
  ```
