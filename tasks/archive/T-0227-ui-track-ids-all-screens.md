---
id: T-0227
title: Имена всех кнопок, вкладок и переключателей оболочки — и `track` обязателен
epic: E11
priority: P3
status: done
owner: claude-16 / haiku-5.5 / medium
author: claude-lead-1
size: M
depends_on: [T-0226]
zones:
  - scripts/test/ui-track-ids.test.ts
  - scripts/test/ui-track-baseline.json
  - packages/app-shell/src/design-system/components/Button.tsx
  - packages/app-shell/src/design-system/components/Layout.tsx
shared:
  - packages/app-shell/src/screens/**
  - packages/app-shell/src/app/**
  - packages/app-shell/src/design-system/components/**
  - docs/27-design-system-and-app-shell.md
  - packages/app-shell/test/button-resting.test.ts
  - packages/app-shell/test/button-shine.test.ts
  - packages/app-shell/test/shop-look.test.ts
  - packages/app-shell/test/tab-badge.test.ts
  - packages/app-shell/test/cut-frame.test.ts
  - packages/app-shell/test/glow-layer.test.ts
  - packages/app-shell/test/ui-clicks.test.ts
  - tasks/T-0228-ui-clicks-report.md
  - tasks/T-0231-tabs-row-over-three.md
  - tasks/epics.md
  - packages/app-shell/src/ads/ad-creative.tsx
runner: any
executor: haiku-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0227. Имена всех кнопок, вкладок и переключателей оболочки — и `track` обязателен

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0227.json)](../README.md#значки-статуса) [![T-0226](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0226.json&label=T-0226)](T-0226-ui-clicked-event.md)

## Зачем

После T-0226 нажатия пишутся, но только у кнопок с именем, а без имени —
почти все. После задачи у каждой кнопки, вкладки и переключателя оболочки
есть имя, свойство `track` становится обязательным, и тест-храповик больше
не нужен: без имени кнопка не соберётся.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р141: все
кнопки и вкладки дизайн-системы; тест не пропускает кнопку без id.

Решения `claude-lead-1` от 24.10.2026 — **как давать имя**:

- **По смыслу действия, а не по тексту**, английскими словами через `_`:
  `play`, `back`, `close`, `retry`, `buy`, `claim`, `share`, `invite`,
  `accept`, `decline`, `remove`, `copy`, `save`, `confirm`, `cancel`.
- **Когда на экране несколько одинаковых действий** — с предметом:
  `claim_daily`, `buy_gems_100`, `open_arsenal`, `select_weapon`. Номер
  или id из данных (товар, предмет, друг) в имя **не** входит: имя одно на
  кнопку в коде, а не на строку списка — `buy` у карточки товара, а какой
  товар, видно из соседних событий.
- **Вкладки и переключатели** — имя группы: `tabs` у нижней панели,
  `mode`, `period`, `filter`; пункт добавится сам.
- **Общие компоненты** (шапка, лист, модалка) — имя действия без экрана:
  экран подставит событие.
- **Сомнение в имени** — не выдумывать: вопрос в PR со списком спорных
  кнопок.
- После разметки `track` у `Button`, `IconButton`, `TabBar` и
  `SegmentedControl` — **обязательное** свойство; тест-храповик и база
  удаляются: проверку берёт на себя `typecheck`.

## Как сейчас

- После T-0226: свойство `track` у четырёх компонентов, тест
  `scripts/test/ui-track-ids.test.ts` и база `ui-track-baseline.json` с
  числами по файлам.
- ~127 `<Button`, `IconButton`, 4 вкладки/переключателя в
  `packages/app-shell/src` (`grep -rn "<Button" packages/app-shell/src`).

## Шаги по порядку

1. Разметить файлы по базе — от большего числа к меньшему, **коммитом на
   папку** (`screens/meta`, `screens/run`, `screens/account`, остальные):
   после каждого коммита число в базе уменьшается, тест зелёный.
2. Когда в базе нули — сделать `track` обязательным в `Button.tsx` и
   `Layout.tsx`, удалить тест-храповик и базу; `pnpm typecheck` зелёный.
3. `docs/27` — строка в описании кнопки: `track` обязателен, правила имени
   — из «Решений».

## Чего не трогаем

- Подписи, порядок и вид кнопок — меняется только свойство `track`.
- Сырые `<button>` вне дизайн-системы.
- Панель команды (`apps/admin`).

## Тесты

- Храповик T-0226 ведёт задачу до нуля; на шаге 2 его заменяет
  `typecheck`.
- `ui-clicks.test.ts` (T-0226) зелёный.
- Ручная проверка: открыть три экрана на `pnpm dev`, нажать по кнопке —
  в консоли/вкладке сети событие `ui_clicked` с ожидаемым именем; список
  экранов и имён — в PR.

## Аналитика

Событие `ui_clicked` из T-0226 начинает приходить со всех экранов.

## Настройки и окружение

Нет.

## Документы

`docs/27` — по шагу 3.

## Критерии приёмки

- [ ] У каждой кнопки, вкладки и переключателя оболочки есть `track` по
  правилам имени.
- [ ] `track` обязателен в типах компонентов; храповика и базы нет.
- [ ] Ни текст, ни вид кнопок не изменились.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(app-shell): Имена у всех кнопок для аналитики`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИМЕНА У ВСЕХ КНОПОК**

  Все кнопки, вкладки и переключатели оболочки получили имена по смыслу действия, и событие нажатий приходит со всех экранов. Свойство `track` теперь обязательно — новая кнопка без имени не соберётся.
  ```
