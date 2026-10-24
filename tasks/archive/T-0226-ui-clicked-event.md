---
id: T-0226
title: Событие нажатий `ui_clicked` — разметка встроена в кнопки, вкладки и переключатели
epic: E11
priority: P3
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/app-shell/src/design-system/components/Button.tsx
  - packages/app-shell/src/design-system/components/Layout.tsx
  - packages/app-shell/src/state/ui-clicks.ts
  - packages/app-shell/test/ui-clicks.test.ts
  - scripts/test/ui-track-ids.test.ts
  - scripts/test/ui-track-baseline.json
shared:
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - tasks/T-0227-ui-track-ids-all-screens.md
  - tasks/epics.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0226. Событие нажатий `ui_clicked` — разметка встроена в кнопки, вкладки и переключатели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0226.json)](../README.md#значки-статуса)

## Зачем

Сейчас видно, какие экраны открывают (`screen_viewed`), но не видно, что на
них нажимают: какая кнопка магазина работает, а какую не замечают. После
задачи каждое нажатие кнопки, вкладки и переключателя дизайн-системы пишет
событие `ui_clicked` с устойчивым id «экран.кнопка», а тест следит, чтобы
новые кнопки появлялись уже с id.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р141: нажатие
каждой кнопки и вкладки дизайн-системы — событие `ui_clicked` в нашу
аналитику с устойчивым id «экран.кнопка»; разметка встроена в компоненты;
тест не пропускает кнопку без id; текста кнопки и личных данных в событии
нет.

Решения `claude-lead-1` от 24.10.2026:

- **Поля события** — `screen` (текущий экран из навигации, `ScreenId`) и
  `control` — имя кнопки: латиница, цифры, `_` и `-`, до 48 символов. Id
  «экран.кнопка» — это `screen` + `.` + `control`: экран подставляется сам,
  поэтому общая кнопка (шапка, лист) не тащит в себе имя экрана.
- **Компоненты:**
  - `Button` и `IconButton` — свойство `track?: string`; задано — при
    нажатии (не на выключенной кнопке) `trackClick(track)`;
  - `TabBar` и `SegmentedControl` — свойство `track?: string` группы;
    нажатие пункта — `control` = `<track>.<id пункта>`;
  - сырые `<button>` вне дизайн-системы в этой задаче не трогаются.
- **Отправка** — через тот же `track` из `state/shell.ts`, что и
  `screen_viewed`: очередь, батч, не блокирует нажатие.
- **Тест-храповик.** Сейчас у ~130 кнопок нет имени, разметить их — T-0227.
  `scripts/test/ui-track-ids.test.ts` сканирует `.tsx` оболочки, считает
  по файлу `<Button`, `<IconButton`, `<TabBar` и `<SegmentedControl` без
  `track=` и сверяет с `ui-track-baseline.json` (`{ "<путь>": число }`):
  число в файле **выросло** или появился файл без записи — тест падает с
  именем файла: «новая кнопка без track — дай ей имя». Уменьшилось —
  тест просит уменьшить число в базе. Базу задача заполняет текущими
  числами.
- **Имя не выдумывается из текста кнопки**: подпись меняется, а id должен
  оставаться прежним, иначе ломается сравнение по неделям.

## Как сейчас

- `packages/app-shell/src/design-system/components/Button.tsx:86–…` —
  `Button`: `handleClick` с `uiFeedback`; `IconButton` (159–…).
- `packages/app-shell/src/design-system/components/Layout.tsx:104–…` —
  `TabBar` (`onSelect(item.id)`, 143), `SegmentedControl` (229–…,
  `onSelect`, 269).
- `packages/app-shell/src/state/navigation.ts:115` — `track("screen_viewed",
  …)`; `currentScreen(stack)` (88).
- `packages/app-shell/src/state/analytics.ts` — `ANALYTICS_EVENTS`;
  `backend/api/src/modules/events/event-dictionary.ts:106` — схема
  `screen_viewed`, `id = z.string().max(64)` (23).
- `scripts/test/layer-boundaries.test.ts` — образец теста по исходникам.

## Шаги по порядку

1. `docs/22` §3.3 — строка `ui_clicked`: зачем (что нажимают на экранах,
   отношение к `screen_viewed`), поля.
2. `event-dictionary.ts` — `ui_clicked: { version: 1, payload: payload({
   screen: id, control: z.string().regex(/^[a-z0-9_-]{1,24}(\.[a-z0-9_-]{1,24})?$/) }) }`.
3. `analytics.ts` — имя в `ANALYTICS_EVENTS`.
4. `state/ui-clicks.ts` — `trackClick(control)`: текущий экран из
   `useNavigation`, проверка формата `control` (неверный — `console.warn` и
   без события), `track("ui_clicked", …)`.
5. `Button.tsx`, `Layout.tsx` — свойство `track` по «Решениям».
6. Тест-храповик и база.
7. `docs/27` §… (дизайн-система, где описаны свойства кнопки) — строка о
   `track`: имя кнопки — по смыслу действия (`buy`, `claim`, `share`), а не
   по тексту.

## Чего не трогаем

- Разметку экранов — T-0227.
- Отчёт по нажатиям — T-0228.
- Сырые `<button>` вне дизайн-системы.

## Тесты

Первым коммитом.

- `ui-clicks.test.ts`:
  - `Button track="buy"` на экране `shop` → событие `{ screen: "shop",
    control: "buy" }`;
  - выключенная кнопка с `track` → события нет;
  - `TabBar track="tabs"` → нажатие пункта `friends` → `control:
    "tabs.friends"`;
  - `control` с пробелом или кириллицей → предупреждение, события нет.
- `ui-track-ids.test.ts` — на временных файлах: кнопка без `track` в файле
  с базой 0 → падение с именем файла; число меньше базы → падение с
  просьбой уменьшить; совпадает → зелёный.
- `scripts/test/event-dictionary.test.ts` зелёный.

## Аналитика

Новое событие `ui_clicked` — по шагам 1–3.

## Настройки и окружение

Нет.

## Документы

`docs/22` §3.3, `docs/27` — по шагам 1 и 7.

## Критерии приёмки

- [ ] Нажатие кнопки, вкладки или переключателя с `track` пишет
  `ui_clicked` с экраном и именем.
- [ ] Новая кнопка без `track` роняет тест с именем файла.
- [ ] Событие есть в словаре, на сервере и в оболочке.
- [ ] `pnpm budget` не вырос заметно (больше 1 КБ — объяснить в PR).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Событие нажатий кнопок ui_clicked`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СОБЫТИЕ НАЖАТИЙ КНОПОК**

  Кнопки, вкладки и переключатели дизайн-системы получили свойство `track`: нажатие пишет событие `ui_clicked` с экраном и именем кнопки. Тест не пускает новые кнопки без имени; старые разметит следующая задача.
  ```
