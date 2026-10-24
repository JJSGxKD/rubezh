---
id: T-0204
title: Архив задач — готовые и отменённые в `tasks/archive/`
epic: E0
priority: P1
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: []
zones:
  - scripts/tasks/registry.mjs
  - scripts/tasks/task-file.mjs
  - scripts/tasks/epics.mjs
  - scripts/tasks/git-io.mjs
  - scripts/tasks/task.mjs
  - scripts/tasks/zones.mjs
  - scripts/tasks/board-page.mjs
  - scripts/release/pr-check.mjs
  - scripts/test/tasks-registry.test.ts
  - scripts/test/tasks-file.test.ts
  - scripts/test/tasks-epics.test.ts
  - scripts/test/tasks-zones.test.ts
  - scripts/test/tasks-board-page.test.ts
  - scripts/test/pr-check.test.ts
shared:
  - tasks/T-*.md
  - tasks/archive/**
  - tasks/epics.md
  - tasks/README.md
  - .claude/skills/take-task/SKILL.md
  - .claude/skills/task-spec/SKILL.md
  - AGENTS.md
runner: any
executor: sonnet-5.5
effort: medium
release: none
design: null
batch: 2
---

# T-0204. Архив задач — готовые и отменённые в `tasks/archive/`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0204.json)](../README.md#значки-статуса)

## Зачем

В `tasks/` больше двухсот файлов, из них 135 — сделанные и отменённые задачи.
Открытые в этом списке теряются: чтобы найти, что брать, приходится листать
историю. После задачи в `tasks/` лежат только открытые задачи, а готовые и
отменённые переезжают в `tasks/archive/` — сами, той же командой
`pnpm task fix`, которой исполнитель и так ставит значки.

## Решения

Решение владельца от 24.10.2026 (разбор входящих, вопрос В1):

- **Две папки:** `tasks/` — задачи в `draft`, `ready` и `in-progress`;
  `tasks/archive/` — в `done` и `cancelled`. Папок на каждый статус нет: файл
  переезжает один раз, когда задача закрыта.
- **Переносит скрипт, а не человек.** `pnpm task fix` переносит файл по
  статусу и чинит все ссылки на него. Исполнитель ставит `status: done` и
  запускает `pnpm task fix` в том же PR — переезд файла едет вместе с
  задачей.
- **Неверное место — ошибка реестра.** `done` или `cancelled` в `tasks/` и
  открытая задача в `tasks/archive/` роняют `pnpm task check` и тест реестра
  с подсказкой «поправит pnpm task fix».
- **Все читатели видят обе папки:** доска, захват, проверка зон, проверка
  описания PR. Задача — это по-прежнему `T-NNNN-slug.md`, в какой бы папке
  она ни лежала.

Решения `claude-lead-1` от 24.10.2026:

- **Путь задачи — относительно `tasks/`.** У задачи в реестре, кроме
  `fileName` (имя файла, как сейчас), появляется `path`: `T-0144-…md` или
  `archive/T-0100-…md`. Ссылки считаются от папки файла, где стоит ссылка:
  из `tasks/` в архив — `archive/T-…md`, из архива в `tasks/` —
  `../T-…md`, из архива в архив — `T-…md`. Ссылка значка статуса на
  `README.md` из архива — `../README.md#значки-статуса`.
- **Чинятся все ссылки на файлы задач** в `tasks/*.md`, `tasks/archive/*.md`
  и `tasks/epics.md`: и в строке значков, и в тексте. Ссылка узнаётся по
  цели вида `](<префикс>T-NNNN-slug.md<#якорь>)`, где префикс — пусто,
  `../`, `archive/` или `../archive/`. Цель переписывается на верный путь
  по реестру, якорь сохраняется. Ссылки на чужие пути и файлы вне реестра
  не трогаются.
- **Первая строка описания PR** — `Задача: tasks/T-NNNN-….md` или
  `Задача: tasks/archive/T-NNNN-….md`: принимаются обе, файл ищется в
  ветке PR в обеих папках. К моменту PR задача уже `done`, поэтому
  исполнитель пишет путь в архив.
- **Переезд всех нынешних готовых задач — в этом же PR**, одним коммитом
  `chore(tasks): Перенести готовые задачи в архив` (результат
  `pnpm task fix`), отдельно от коммитов с кодом.

## Как сейчас

- `scripts/tasks/registry.mjs:12–14` — `isTaskFile(name)`: имя начинается с
  `T-`. `readTasks(files)` (строки 26–55) получает `[{ name, text }]`, где
  `name` — имя файла без каталога, и кладёт его в `fileName`. Строки 43–44 —
  карта `fileNames` id → имя файла для строки значков.
- `scripts/tasks/task-file.mjs:204–206` — `taskBadge(id, fileName)`: ссылка
  значка — голое имя файла. `badgeLine(task, fileNames)` (213–221) — значок
  статуса со ссылкой `README.md#значки-статуса` и значки зависимостей.
  `badgeProblem` (247–…) сверяет строку значков с ожидаемой.
- `scripts/tasks/epics.mjs:30` — ячейка «Задачи» эпика: `taskBadge(task.id,
  task.fileName)`.
- `scripts/tasks/git-io.mjs:38–43` — `readOriginTasks`: `git ls-tree
  --name-only <base> tasks/` — только верхний уровень. `readBranchFile`
  (131–134) — `origin/task/<id>:tasks/<fileName>`.
- `scripts/tasks/task.mjs`:
  - `runCheck` (154–165) и `runFix` (167–197) читают `readdirSync(tasks/)`;
  - `runClaim` (235) пишет `tasks/<fileName>` — открытая задача, файл в
    `tasks/`;
  - `runResume` (300) пишет `tasks/<fileName>` в ветке задачи, а там файл
    уже может лежать в архиве (PR на доработке закрыл задачу);
  - `runDiffCheck` (346–352) ищет `tasks/<id>-*.md` только наверху.
- `scripts/tasks/zones.mjs:62–64` — `outOfZone`: разрешён только
  `tasks/<fileName>`.
- `scripts/tasks/board-page.mjs:102` и `:121` — ссылки доски
  `${TASKS_URL}/${fileName}`.
- `scripts/release/pr-check.mjs:121–137` — `checkTaskLine`: регулярка
  `^Задача:\s*`?tasks\/(T-\d{4})-[^\s`/]+\.md`?\s*$`; `taskFilesAt` (154–157) —
  `ls-tree tasks/` без вложенных папок.
- `scripts/test/tasks-registry.test.ts:70–75` — проверка реестра на диске
  читает `readdirSync(TASKS_DIR)`.

## Шаги по порядку

1. **`registry.mjs`.**
   - Файл на входе `readTasks` — `{ name, text }`, где `name` — путь
     относительно `tasks/`: `T-0001-x.md` или `archive/T-0001-x.md`.
     `isTaskFile(name)` смотрит на имя без каталога.
   - Имя проверяется `FILE_NAME_RE` по имени без каталога. Каталог, кроме
     пустого и `archive/`, — ошибка `<путь>: задачи лежат только в tasks/ и
     tasks/archive/`.
   - Задача получает `fileName` (имя без каталога) и `path` (путь
     относительно `tasks/`). Карта для значков — `paths`: id → `path`.
   - Новая проверка `checkPlacement(tasks)` → ошибки:
     `<path>: задача в статусе done лежит не в архиве — перенесёт pnpm task fix`
     и `<path>: задача в статусе ready лежит в архиве — перенесёт pnpm task fix`
     (подставляется настоящий статус). Вызывается из `checkRegistry`.
   - Экспорт `placementPath(task)` → верный путь по статусу:
     `archive/<fileName>` для `done` и `cancelled`, иначе `<fileName>`.
2. **`task-file.mjs`.**
   - `relativeTaskLink(fromPath, toPath)` — относительная ссылка из файла
     `fromPath` на `toPath`, оба относительно `tasks/`, разделитель всегда
     `/` (через `node:path/posix`).
   - `taskBadge(id, target)` — второй аргумент теперь готовая ссылка.
   - `badgeLine(task, paths)` — ссылки считаются от `task.path`: значок
     статуса ведёт на `relativeTaskLink(task.path, "README.md")` с
     `#значки-статуса`, значок зависимости — на
     `relativeTaskLink(task.path, paths[id])`.
   - `withTaskLinks(text, fromPath, paths)` → текст, где каждая цель ссылки
     вида `](<префикс>T-NNNN-slug.md<#якорь>)` (префикс из «Решений»)
     переписана на `relativeTaskLink(fromPath, paths[id])` + якорь. id
     берётся из имени; id нет в `paths` — ссылка не трогается.
   - `badgeProblem` и `validateTask` получают `paths` вместо `fileNames`;
     сообщения об ошибке называют `path`.
3. **`epics.mjs`.** Ячейка «Задачи» — `taskBadge(task.id,
   relativeTaskLink("epics.md", task.path))`; задача в архиве — ссылка
   `archive/T-…md`.
4. **`git-io.mjs`.**
   - `readOriginTasks` читает `tasks/` и `tasks/archive/`: `ls-tree
     --name-only <base> tasks/ tasks/archive/`, имя на выходе — путь
     относительно `tasks/`.
   - `readBranchFile(id, fileName)` пробует `tasks/<fileName>`, потом
     `tasks/archive/<fileName>`.
5. **`task.mjs`.**
   - Общая функция чтения рабочей копии `readWorkingTasks()` → файлы
     `tasks/*.md` и `tasks/archive/*.md` с путями относительно `tasks/`.
     Ею пользуются `runCheck`, `runFix` и `runDiffCheck`. Папки
     `tasks/archive/` может не быть — тогда читается только `tasks/`.
   - `runFix`, по порядку: (а) переносит файлы, чей `path` не равен
     `placementPath(task)`, — `renameSync`, папка `tasks/archive/`
     создаётся при надобности; печатает `перенесено: tasks/<было> →
     tasks/<стало>`; (б) пересчитывает пути; (в) ставит строку значков и
     чинит ссылки `withTaskLinks` во всех файлах задач и в `epics.md`;
     (г) чинит ячейки эпиков, как сейчас. Повторный запуск ничего не меняет.
   - `runResume` находит файл задачи в ветке по id в `tasks/` или
     `tasks/archive/`.
   - `runDiffCheck` ищет файл `<id>-*.md` в обеих папках.
   - `runCheck` печатает число задач в обеих папках: «Реестр задач в
     порядке: 210 задач (открытых 70, в архиве 140).»
6. **`zones.mjs`.** `outOfZone` разрешает `tasks/<fileName>` и
   `tasks/archive/<fileName>`: задача, закрытая в своём PR, переезжает в
   архив, и это не выход за зоны.
7. **`board-page.mjs`.** Ссылки доски — `${TASKS_URL}/${path}`.
8. **`pr-check.mjs`.** `checkTaskLine` принимает `tasks/T-NNNN-….md` и
   `tasks/archive/T-NNNN-….md`; `taskFilesAt` читает обе папки, путь на
   выходе — относительно `tasks/`. Текст ошибки: «первая строка описания
   должна быть «Задача: tasks/archive/T-NNNN-….md»» — к PR задача уже
   закрыта.
9. **Переезд.** `pnpm task fix` на ветке — отдельным коммитом из «Решений».
   Затем `pnpm task check` зелёный.
10. **Документы:**
    - `tasks/README.md`, «Файлы»: строка про `archive/` — «готовые и
      отменённые задачи; переносит `pnpm task fix`»; в «Как взять задачу»,
      шаг закрытия: «`status: done`, затем `pnpm task fix` — файл уедет в
      `tasks/archive/`»; в шаге «Открыть PR» первая строка — `Задача:
      tasks/archive/T-NNNN-….md`;
    - скилл `take-task`, шаг «Закрытие» — те же две строки;
    - `AGENTS.md` — строка о закрытии задачи;
    - скилл `task-spec`, шаг 5 — номер задачи ищется в обеих папках.

## Чего не трогаем

- Содержимое задач, кроме ссылок и строки значков.
- `task-board.yml` и формат значков статуса на ветке `task-board`.
- `claim.mjs` и правила захвата: открытые задачи остаются в `tasks/`.
- Ссылки на задачи из `docs/`: там задачи называют номером, а не ссылкой.

## Тесты

Первым коммитом.

- `tasks-registry.test.ts`:
  - `archive/T-0002-x.md` в статусе `done` → ошибок нет; `path` у задачи —
    `archive/T-0002-x.md`, `fileName` — `T-0002-x.md`;
  - `T-0002-x.md` в статусе `done` наверху → ошибка с `перенесёт pnpm task
    fix`; то же для `cancelled`;
  - `archive/T-0003-x.md` в статусе `ready` → ошибка;
  - `old/T-0004-x.md` → ошибка о папке;
  - зависимость открытой задачи на архивную: ожидаемая строка значков
    ведёт на `archive/T-0002-x.md`; у архивной на открытую — `../T-0001-x.md`,
    значок статуса архивной — `../README.md#значки-статуса`;
  - проверка реестра на диске читает и `tasks/archive/`.
- `tasks-file.test.ts`:
  - `relativeTaskLink` — четыре сочетания папок из «Решений»;
  - `withTaskLinks`: `](T-0002-task-cli.md)` из `tasks/` при архивной T-0002 →
    `](T-0002-task-cli.md)`; `](T-0001-shop-gems-only-bundles.md#шаги)` из архива при
    открытой T-0001 → без изменений; `](T-9999-x.md)` без задачи в реестре →
    без изменений; `](docs/x.md)` → без изменений; повторный вызов ничего
    не меняет.
- `tasks-epics.test.ts` — ячейка эпика с архивной задачей ведёт на
  `archive/…`.
- `tasks-zones.test.ts` — `outOfZone(["tasks/archive/T-0001-x.md",
  "tasks/T-0001-x.md"], задача T-0001)` → пусто; чужой
  `tasks/archive/T-0002-x.md` → вне зон.
- `tasks-board-page.test.ts` — ссылка на архивную задачу в разделе «Готово»
  ведёт на `…/blob/dev/tasks/archive/T-…md`.
- `pr-check.test.ts`: `Задача: tasks/archive/T-0001-x.md` при файле в архиве
  ветки → ошибок нет; `Задача: tasks/T-0001-x.md` при файле наверху →
  ошибок нет; путь есть в строке, а файла нет ни там, ни там → ошибка.

## Аналитика

Нет: инструмент команды.

## Настройки и окружение

Нет.

## Документы

`tasks/README.md` («Файлы», «Как взять задачу»), скиллы `take-task` и
`task-spec`, `AGENTS.md` — по шагу 10.

## Критерии приёмки

- [ ] В `tasks/` после PR — только открытые задачи, служебные файлы и папка
  `archive/`; все `done` и `cancelled` — в `tasks/archive/`.
- [ ] `pnpm task fix` на чистой ветке после PR ничего не меняет;
  `pnpm task check` зелёный.
- [ ] Ссылки значков и ячеек эпиков открываются на GitHub и из архива, и
  наверху (проверить три ссылки руками в ветке PR).
- [ ] `pnpm task board`, `pnpm task next`, `claim`, `resume`, `diff-check` и
  `claim-check` работают с задачами в обеих папках.
- [ ] Коммит переезда — отдельный от коммитов с кодом.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `chore(tasks): Архив готовых и отменённых задач`
- **Метка:** `release: none`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — АРХИВ ЗАДАЧ**

  Готовые и отменённые задачи переехали в `tasks/archive/`, в `tasks/` остались только открытые. Переносит `pnpm task fix`: исполнитель ставит `status: done`, запускает его, и файл уезжает в архив в том же PR. Ссылки значков и эпиков скрипт чинит сам. PR, открытые до мерджа, после вливания `dev` получат красный тест реестра, пока в них не запустят `pnpm task fix`.
  ```
