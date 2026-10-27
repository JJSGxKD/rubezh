---
id: T-0265
title: Ярмарка — клиент: раздел в магазине с портретами, ценой и «уйдёт через N дней»
epic: E1
priority: P3
status: draft
owner:
author: claude-lead-1
size: S
depends_on: [T-0264, T-0246]
zones:
  - packages/app-shell/src/state/fair-api.ts
  - packages/app-shell/src/screens/meta/fair.tsx
  - packages/app-shell/test/fair.test.ts
shared:
  - packages/app-shell/src/screens/meta/shop.tsx
  - packages/app-shell/src/screens/meta/appearance-art.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0265. Ярмарка — клиент: раздел в магазине с портретами, ценой и «уйдёт через N дней»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0265.json)](README.md#значки-статуса) [![T-0264](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0264.json&label=T-0264)](T-0264-fair-server.md) [![T-0246](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0246.json&label=T-0246)](T-0246-keeper-set-shell.md)

> **Черновик до обликов** — как T-0264.

## Зачем

После задачи в магазине есть раздел «Ярмарка»:
- три карточки недели с крупным портретом облика, ценой в самоцветах и
  «уйдёт через N дней»;
- купить можно в одно нажатие с подтверждением;
- купленное помечено, а его можно сразу надеть.

## Решения

Решения владельца — Р154 и поправка 24.10.2026 (только своё); Р11 — видно
до покупки.

Решения `claude-lead-1` от 24.10.2026:

- **Раздел** `fair.tsx` — в магазине над пакетами самоцветов, если
  Ярмарка включена (ответ не 404). Сверху заголовок «Ярмарка» и «Новая
  витрина через {N} дн.».
- **Карточка:** портрет `card-hero-<id>.svg` (по правилу арта зрителя T-0238;
  без арта — раздела нет), рамка редкости, имя, цена «{price} 💎»; купленное —
  «Куплено» и «Надеть».
- **Покупка** — лист подтверждения «{имя} за {price} самоцветов?», затем
  отклик начисления (#460); не хватает — «Не хватает самоцветов» и кнопка к
  пакетам.

## Как сейчас

После T-0264 — `GET /api/v1/fair`, покупка. После T-0238 — `appearance-art.ts`,
надевание облика.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`state/fair-api.ts`** — схемы, `load()`, `buy(id)`, коды ошибок.
3. **`fair.tsx`** и место в `shop.tsx`.
4. **Витрина компонентов** — раздел в трёх состояниях.
5. **Событие** `fair_purchased` при успехе (словарь — T-0264).
6. **Тексты `ru.json`:**
   - `"fair.title": "Ярмарка"`, `"fair.next": "Новая витрина через {days} дн."`;
   - `"fair.price": "{price} 💎"`, `"fair.owned": "Куплено"`, `"fair.wear": "Надеть"`;
   - `"fair.confirm": "{name} за {price} самоцветов?"`, `"fair.noGems": "Не хватает самоцветов"`.
7. **`docs/27`** — строка «Магазин».

## Чего не трогаем

- Сервер — T-0264.

## Сценарий и интерфейс

Магазин → «Ярмарка · новая витрина через 3 дн.» → Скоморох за 600 💎 →
подтверждение → куплено → «Надеть» → облик в арсенале. Проверить 320, 390,
768.

## Тесты

Первым коммитом, `fair.test.ts`:
- разбор ответа;
- купленное — «Куплено» и «Надеть»;
- 409 `insufficient_funds` → «Не хватает самоцветов»;
- 404 → раздела нет.

## Аналитика

По шагу 5.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] В магазине — Ярмарка недели с портретами, ценой и сроком; покупка за самоцветы и «Надеть».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Ярмарка обликов`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Ярмарка в магазине — облики и окрасы на неделю за самоцветы`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЯРМАРКА ОБЛИКОВ**

  В магазине — раздел «Ярмарка»: три облика или окраса недели с портретом, ценой в самоцветах и сроком. Купленное можно сразу надеть.
  ```
