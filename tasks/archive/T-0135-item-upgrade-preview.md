---
id: T-0135
title: Карточка предмета — «было → станет» перед улучшением
epic: E6
priority: P2
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/items/item-views.ts
  - backend/api/test/items.test.ts
  - packages/app-shell/src/state/items-api.ts
  - packages/app-shell/src/screens/meta/arsenal-item.tsx
  - packages/app-shell/src/screens/meta/arsenal-parts.tsx
  - packages/app-shell/test/items.test.ts
shared:
  - packages/app-shell/src/i18n/ru-arsenal.json
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 2
---

# T-0135. Карточка предмета — «было → станет» перед улучшением

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0135.json)](../README.md#значки-статуса)

## Зачем

На карточке предмета в арсенале игрок видит цену улучшения, но не видит, что
получит: сколько добавит главное свойство, дополнительные и мощь
(`tasks/inbox.md`, 05.10). В забеге это уже есть — карточка выбора улучшения
показывает «урон 7 → 8» (`core-game`, `upgrade-changes.ts`). Понятная выгода
— повод тратить монеты и возвращаться за ними.

## Решения

- **Числа «станет» считает сервер**, как и нынешние значения: клиент правил
  снаряжения не знает (`item-views.ts`, комментарий над `ItemView`). В ответе
  предмета — необязательное поле `next`: уровень, мощь, главное и
  дополнительные свойства на следующем уровне. Поле есть, только когда
  `upgrade` не `null`.
- **Вид** — как на карточке улучшения в забеге: «значение → новое значение»,
  новое — цветом успеха. На максимальном уровне строки не меняются.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: под кнопкой
  «Улучшить» строка «Мощь {from} → {to}».

## Как сейчас

- `backend/api/src/modules/items/item-views.ts:10–26` — `ItemView`: `level`,
  `power`, `main`, `extras`, `upgrade` (`null` — потолок аккаунта).
  `itemView` (строки 46–61) считает значения через `statValue(stat, rarity, level, roll)`
  и `itemPower(shape)` из `item-rules.ts`.
- `packages/app-shell/src/state/items-api.ts:20–38` — Zod-схема предмета.
- `packages/app-shell/src/screens/meta/arsenal-item.tsx` — лист предмета:
  свойства и кнопка «Улучшить» с ценой (строки 44–50). Значение свойства — в
  `arsenal-parts.tsx:124`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`item-views.ts`** — `ItemView` += `next?: { level: number; power: number; main: { stat; value }; extras: { stat; value }[] }`.
   В `itemView`: если `upgradeCost(...)` не `null` — посчитать те же величины
   для `{ ...shape, level: row.level + 1 }` теми же функциями, без своей формулы.
3. **`items-api.ts`** — `next` необязательным полем схемы: старый сервер его
   не пришлёт, карточка открывается как раньше.
4. **`arsenal-parts.tsx`** — у строки свойства необязательный `nextValue`:
   есть и отличается — «{value} → {next}», новое — цветом успеха из токенов.
5. **`arsenal-item.tsx`** — передать `nextValue` главному и дополнительным
   свойствам из `item.next`. Под кнопкой «Улучшить» — строка
   `arsenal.item.powerNext`: «Мощь {from} → {to}».
6. **`ru-arsenal.json`** — ключ `arsenal.item.powerNext`: «Мощь {from} → {to}».

## Чего не трогаем

- Правила снаряжения: `item-rules.ts`, цены, потолки, перековка и слияние.
- Список арсенала и вкладки.

## Тесты

- `backend/api/test/items.test.ts`:
  - предмет ниже потолка → `next.level = level + 1`, `next.main.value` и
    `next.power` равны `itemView` того же предмета уровнем выше;
  - предмет в потолке аккаунта (`upgrade: null`) → `next` нет.
- `packages/app-shell/test/items.test.ts` — схема разбирает предмет с `next` и
  без него.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет: экран арсенала в `docs/27` описан без этих подробностей.

## Критерии приёмки

- [ ] На карточке предмета ниже потолка видно «было → станет» у главного и
  дополнительных свойств и «Мощь {from} → {to}» под «Улучшить».
- [ ] В потолке строки как раньше, без стрелок.
- [ ] Числа «станет» совпадают с теми, что покажет карточка после улучшения.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `feat(app-shell): Карточка предмета — «было → станет»`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: на карточке предмета видно, что даст улучшение — «было → станет»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВИДНО, ЧТО ДАСТ УЛУЧШЕНИЕ**

  Карточка предмета в арсенале показывает свойства и мощь «было → станет» до нажатия «Улучшить». Числа считает сервер, так что они совпадут с тем, что получит игрок.
  ```
