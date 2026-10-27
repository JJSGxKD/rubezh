---
id: T-0209
title: Готовые промты потоков с номером аккаунта — на доске и в `pnpm task streams`
epic: E0
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0206]
zones:
  - scripts/tasks/board.mjs
  - scripts/tasks/board-page.mjs
  - scripts/tasks/task.mjs
  - scripts/test/tasks-board.test.ts
  - scripts/test/tasks-board-page.test.ts
shared:
  - tasks/README.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0209. Готовые промты потоков с номером аккаунта — на доске и в `pnpm task streams`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0209.json)](README.md#значки-статуса) [![T-0206](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0206.json&label=T-0206)](archive/T-0206-board-work-review-columns.md)

## Зачем

Чтобы запустить поток, сейчас копируют промт из `tasks/README.md` и руками
подставляют номер аккаунта, модель и уровень. Ошибка в номере путает
подсчёт вклада, а запуск уже работающего потока — даёт две сессии на одну
пару. После задачи доска и `pnpm task streams --account claude-N` выдают
готовые промты для конкретного аккаунта — только для тех потоков, которые
на этом аккаунте сейчас не работают и которым есть что делать.

## Решения

Решение владельца от 24.10.2026 (разбор входящих, вопрос В7): команды
запуска потоков на доске нужны, **только если они учитывают номер
аккаунта, который их запускает**.

Решения `claude-lead-1` от 24.10.2026:

- **Промт — один шаблон в коде**, `flowPrompt({ account, executor, effort,
  runner })` в `board.mjs`. Текст — «Промт потока» из `tasks/README.md`
  (после T-0207 — с «запустил: владелец»), с подстановкой. Для `runner`
  `local` и `owner` в команду `pnpm task next` добавляется `--runner local`
  или `--runner owner`. Блок в `tasks/README.md` остаётся, с заглушками
  `claude-N / sonnet-5.5 / medium`, и тест сверяет его с шаблоном: текст в
  двух местах не разойдётся.
- **Какие потоки предлагать аккаунту** — пары «модель + уровень + вид» из
  «Запускать сейчас» (есть свободные или доработка), кроме тех, где у этого
  аккаунта есть задача «В работе» той же модели и уровня: поток уже идёт.
  PR «На ревью» поток не занимает — открыв PR, поток берёт следующую задачу.
- **Аккаунты на доске** — те, что встречаются в поле `owner` задач «В
  работе», «На ревью», «Доработки» и задач, влитых за последние 14 суток.
  Сортировка по номеру. Аккаунт, которого там нет, получает промты командой.
- **На доске** — подраздел `### Запуск по аккаунтам` в «Потоках сейчас»:
  на аккаунт — `<details>` с заголовком «claude-2 — запустить 3: sonnet-5.5
  / medium, haiku-5.5 / low, sonnet-5.5 / high · local», внутри — промты
  блоками кода. Нечего запускать — строка «claude-2 — всё нужное уже
  работает».
- **Команда** `pnpm task streams --account claude-2` печатает те же промты
  после таблиц; номер — `claude-` и цифры, иначе ошибка «Аккаунт — в виде
  claude-N».
- Строка «запустил: владелец» в промте — по умолчанию; помощник меняет её
  на «запустил: помощник <ник>» сам. Флага для этого нет.

## Как сейчас

- `scripts/tasks/board.mjs` — `streamsSummary` (`board` → `{ streams,
  epics }`), `streamRows`, `renderStreamsText`; поток —
  `{ executor, effort, runner, now, queue }`.
- `scripts/tasks/board-page.mjs` — `streamsSection(streams)`: таблицы
  «Запускать сейчас» и «На очереди».
- `scripts/tasks/task.mjs` — `runStreams(flags)`: флаг `--epic`.
- `tasks/README.md`, «Автопоток», «Промт потока» — блок кода с текстом
  промта.

## Шаги по порядку

1. **`board.mjs`.**
   - `export function flowPrompt({ account, executor, effort, runner })` →
     текст промта.
   - `export function accountStreams(account, board, streams)` → потоки
     для запуска по правилу «Решений».
   - `export function knownAccounts(board, credits, now)` → список
     `claude-N` по правилу «Решений», по возрастанию номера.
2. **`board-page.mjs`.** Подраздел «Запуск по аккаунтам» в конце
   `streamsSection`.
3. **`task.mjs`.** `--account` у `runStreams` и в `USAGE`.
4. **`tasks/README.md`**, «Автопоток» — абзац: «Готовый промт с номером
   своего аккаунта — `pnpm task streams --account claude-N` или подраздел
   «Запуск по аккаунтам» на доске; там только потоки, которые на этом
   аккаунте сейчас не работают». Блок «Промт потока» — не менять, кроме
   того, что требует сверка с шаблоном.

## Чего не трогаем

- Таблицы «Запускать сейчас» и «На очереди».
- Значки потоков эпиков.
- Как поток берёт задачу (`claim`, `resume`).

## Тесты

Первым коммитом.

- `tasks-board.test.ts`:
  - `flowPrompt({ account: "claude-2", executor: "haiku-5.5", effort:
    "low", runner: "any" })` содержит «поток claude-2 / haiku-5.5 / low» и
    «pnpm task next --executor haiku-5.5 --effort low» без `--runner`; с
    `runner: "local"` — «--runner local»;
  - блок «Промт потока» из `tasks/README.md` равен `flowPrompt({ account:
    "claude-N", executor: "sonnet-5.5", effort: "medium", runner: "any" })`;
  - `accountStreams`: у claude-2 задача «В работе» sonnet-5.5 / medium →
    этого потока в списке нет, а у claude-3 — есть; задача claude-2 «На
    ревью» поток не занимает;
  - `knownAccounts`: владелец задачи, влитой 20 суток назад, не попадает;
    10 суток назад — попадает; claude-10 идёт после claude-9.
- `tasks-board-page.test.ts` — подраздел «Запуск по аккаунтам» с
  `<details>` на аккаунт и строкой «всё нужное уже работает» у аккаунта
  без свободных потоков.

## Аналитика

Нет: инструмент команды.

## Настройки и окружение

Нет.

## Документы

`tasks/README.md` — по шагу 4.

## Критерии приёмки

- [ ] `pnpm task streams --account claude-2` печатает промты только для
  потоков, которым есть что делать и которые на claude-2 не идут.
- [ ] На доске у каждого известного аккаунта — свои промты с его номером.
- [ ] Промт в `tasks/README.md` и шаблон в коде сверяет тест.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(dev): Промты потоков с номером аккаунта`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОМТЫ ПОТОКОВ С НОМЕРОМ АККАУНТА**

  Доска и `pnpm task streams --account claude-N` выдают готовые промты для своего аккаунта: номер, модель и уровень уже подставлены, а потоки, которые на этом аккаунте уже работают, не предлагаются. Копировать промт из README и править руками больше не нужно.
  ```
