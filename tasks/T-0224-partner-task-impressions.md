---
id: T-0224
title: Показы партнёрских заданий — событие `task_shown` при открытии экрана заданий
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0105, T-0107]
zones:
  - packages/app-shell/src/screens/meta/tasks.tsx
  - packages/app-shell/test/tasks-screen.test.ts
shared:
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
runner: any
executor: haiku-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0224. Показы партнёрских заданий — событие `task_shown` при открытии экрана заданий

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0224.json)](README.md#значки-статуса) [![T-0105](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0105.json&label=T-0105)](T-0105-task-points-and-rewards.md) [![T-0107](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0107.json&label=T-0107)](T-0107-achievements-showcase-shell.md)

## Зачем

Заказчику подписки нужен отчёт «показали — нажали — выполнили» (Р140). Нажатия
(`task_link_opened`) и выполнения уже записываются, а показов нет: не понять,
сколько игроков вообще видели задание. После задачи каждое открытие экрана
заданий пишет по событию на каждое видимое партнёрское задание.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р140: в отчёте
заказчику — показы, нажатия, выполнения и удержание по дням.

Решения `claude-lead-1` от 24.10.2026:

- **Событие** `task_shown`, версия 1, поля `task` (id задания) и `kind`
  (`channel`, `bot`, `link`) — как у `task_link_opened`.
- **Когда** — один раз на задание за открытие экрана заданий, когда
  список заданий загружен. Показ считается, если карточка партнёрского
  задания отрисована в списке; прокрутка до неё не нужна — экран короткий,
  а точность «увидел глазами» не окупает наблюдатель видимости. Возврат на
  экран — новое открытие и новые события.
- **Задания сетей** (`network-tasks.tsx`) — не в этой задаче: их показы
  считает сама сеть.
- Порядок по правилу словаря: сначала строка в
  `docs/22-analytics-and-metrics.md` §3.3, затем `event-dictionary.ts`,
  затем `ANALYTICS_EVENTS` в оболочке и код. Расхождение ловит
  `scripts/test/event-dictionary.test.ts`.

## Как сейчас

- `packages/app-shell/src/screens/meta/tasks.tsx:143` — `track("task_link_opened",
  { task: task.id, kind: task.kind })` при нажатии.
- `packages/app-shell/src/state/analytics.ts` — `ANALYTICS_EVENTS` (строка
  10–…) и `track`.
- `backend/api/src/modules/events/event-dictionary.ts:237` — схема
  `task_link_opened`.
- `docs/22-analytics-and-metrics.md` — строка `task_link_opened` в словаре
  (строка 225).

## Шаги по порядку

1. `docs/22` §3.3 — строка `task_shown` рядом с `task_link_opened`: зачем
   (знаменатель отчёта заказчику), поля.
2. `event-dictionary.ts` — `task_shown: { version: 1, payload: payload({
   task: id, kind: id }) }`.
3. `analytics.ts` — имя в `ANALYTICS_EVENTS`.
4. `tasks.tsx` — после загрузки списка: для каждой партнёрской цели
   (`kind` из `channel`, `bot`, `link`) — `track("task_shown", …)` один раз
   за монтирование экрана (повторная загрузка того же списка — без новых
   событий).

## Чего не трогаем

- Задания сетей.
- Отчёт заказчику — T-0225.

## Тесты

Первым коммитом, `packages/app-shell/test/tasks-screen.test.ts` (новый,
если такого нет; рядом — по образцу соседних тестов экранов):

- список с двумя партнёрскими заданиями и одним заданием забега → два
  события `task_shown` с `task` и `kind`;
- перезагрузка списка на том же экране → новых событий нет;
- `scripts/test/event-dictionary.test.ts` зелёный — три списка совпадают.

## Аналитика

Новое событие `task_shown` — по шагам 1–3.

## Настройки и окружение

Нет.

## Документы

`docs/22-analytics-and-metrics.md` §3.3.

## Критерии приёмки

- [ ] Открытие экрана заданий пишет по одному `task_shown` на каждое
  партнёрское задание в списке.
- [ ] Событие есть в словаре, на сервере и в оболочке.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Показы партнёрских заданий в аналитике`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОКАЗЫ ПАРТНЁРСКИХ ЗАДАНИЙ**

  Открытие экрана заданий пишет событие `task_shown` на каждое партнёрское задание в списке. Это знаменатель отчёта заказчику: показали — нажали — выполнили — остались.
  ```
