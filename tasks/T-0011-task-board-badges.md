---
id: T-0011
title: Живые значки статуса задач и проверка захвата в CI
epic: E0
priority: P0
status: in-progress
owner: claude-2 / sonnet-5.5
size: M
depends_on: [T-0002]
zones:
  - scripts/tasks/**
  - scripts/test/tasks-*.test.ts
  - .github/workflows/task-board.yml
  - .github/workflows/pr-checks.yml
  - tasks/README.md
  - .claude/skills/take-task/SKILL.md
shared:
  - docs/09-ci-cd.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0011. Живые значки статуса задач и проверка захвата в CI

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0011.json)](README.md#значки-статуса) [![T-0002](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0002.json&label=T-0002)](T-0002-task-cli.md)

## Зачем

У каждой задачи под заголовком стоит строка значков shields.io: статус самой
задачи и статус каждой зависимости. Сейчас значки читают JSON из ветки
`task-board`, который тимлиды обновляют руками. Задача:
- делает JSON живым — его пересчитывает workflow на каждое событие;
- закрывает обход порядка проверкой в CI. Тот, кто взял задачу без
  `pnpm task claim` (заблокированную или в занятой зоне), не пройдёт проверку PR.

## Решения

- **Источник правды — тот же, что у `pnpm task board`** (T-0002):
  - файлы задач в `origin/dev`;
  - ветки `task/*`;
  - открытые PR.

  Классификация — та же функция `classify` из `scripts/tasks/board.mjs`, второй
  копии логики нет.
- **Статус пишется файлом на задачу** —
  `status/T-NNNN.json` в ветке `task-board`. Формат — endpoint-значок
  shields.io:

  ```json
  { "schemaVersion": 1, "label": "статус", "message": "можно брать", "color": "brightgreen", "cacheSeconds": 300 }
  ```

  Ветка `task-board` без общей истории с `dev`: каждый прогон заменяет её
  одним коммитом (`--force`). История статусов не нужна.
- **Сообщения и цвета** — одна таблица в коде, она же — в `tasks/README.md`:

  | Колонка `classify` | `message` | `color` |
  |---|---|---|
  | Свободно | `можно брать` | `brightgreen` |
  | В работе | `в работе · <owner без модели>` | `orange` |
  | На ревью | `на ревью · #<номер PR>` | `blue` |
  | Заблокировано: зависимость | `ждёт T-0003` (до двух номеров, дальше `+N`) | `red` |
  | Заблокировано: зона | `зона занята T-0005` | `red` |
  | Готово | `готово` | `6e40c9` (фиолетовый, как влитый PR) |
  | Черновик | `черновик` | `lightgrey` |
  | Отменено | `отменено` | `inactive` |

- **Строка значков в файле задачи статична.** Её ставят тимлиды, когда пишут
  спецификацию: значок статуса и по значку на каждую зависимость с
  `&label=T-NNNN`. Меняется картинка, а не файл: истории `dev` не нужны
  коммиты на каждый захват. `pnpm task check` сверяет строку с `depends_on`.
- **Проверка захвата в CI** — шаг `claim-check` в джобе `check`
  (`pr-checks.yml`), рядом с `diff-check` из T-0002. Для PR из ветки
  `task/T-NNNN` он падает, если:
  - у задачи на базе статус не `ready` и не `in-progress`;
  - хоть одна зависимость на базе не `done`;
  - зоны задачи пересекаются с зонами другой задачи, у которой есть ветка
    `task/*` или открытый PR. Исключение — задачи, от которых она зависит.

  Сообщение называет, что не так.

## Как сейчас

- После T-0002 в `scripts/tasks/` есть:
  - `task-file.mjs` — разбор и проверка файла задачи;
  - `registry.mjs` — проверка реестра;
  - `zones.mjs` — шаблоны путей и пересечения зон;
  - `board.mjs` — `classify`, раскладка по колонкам;
  - `task.mjs` — команды `check`, `board`, `next`, `claim`, `release`,
    `diff-check`.
- Ветка `task-board` уже существует. В ней `status/T-0001.json` …
  `status/T-0011.json`, которые тимлиды заполнили руками по текущему
  состоянию. Задача заменит их сгенерированными.
- Строка значков стоит в каждой задаче сразу под заголовком `# T-NNNN. …`.
  Образец — строка этого файла.
- `.github/workflows/pr-checks.yml` — джоб `check`, обязательный в ruleset
  `main`. Новые шаги идут в него, а не в новый джоб (комментарий в файле).

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **`scripts/tasks/board.mjs`:**
   - `statusBadge(entry)` → объект endpoint-значка по таблице из «Решений»;
   - `entry` — запись `classify`: задача, колонка, причина, `owner`, номер PR.
3. **`scripts/tasks/task-file.mjs`:**
   - `badgeLine(task)` → строка значков: статус и по значку на каждую
     зависимость в порядке `depends_on`. Формат ссылок — как в этом файле;
     адрес владельца и репозитория — константа рядом;
   - `validateTask` добавляет ошибку, если первой непустой строкой после
     заголовка `# T-NNNN. …` не стоит ровно `badgeLine(task)`.
4. **`scripts/tasks/task.mjs`:**
   - `status-json --out <каталог>` — по `classify` пишет
     `<каталог>/status/<id>.json` на каждую задачу;
   - `claim-check [--base <ref>]` — правила из «Решений». Номер задачи — из
     `GITHUB_HEAD_REF` или текущей ветки; не ветка задачи → пропуск с кодом 0.
5. **Новый `.github/workflows/task-board.yml`.**
   - **Когда:**
     - `create` и `delete` — с `if`, что ref начинается с `task/`;
     - `pull_request` — `opened`, `reopened`, `closed`, `ready_for_review`,
       `converted_to_draft`, с `if`, что ветка начинается с `task/`;
     - `push` в `dev` с `paths: ["tasks/**"]`;
     - `schedule` раз в час — подстраховка;
     - `workflow_dispatch`.
   - `permissions: contents: write`, `pull-requests: read`.
   - `concurrency: { group: task-board, cancel-in-progress: true }`.
   - **Шаги:**
     1. checkout `dev` с `fetch-depth: 0` (actions — те же пины по SHA, что в
        `pr-checks.yml`), setup-node по `.nvmrc`;
     2. `node scripts/tasks/task.mjs status-json --out "$RUNNER_TEMP/board"`,
        с `GH_TOKEN` для списка PR;
     3. в `$RUNNER_TEMP/board`: `git init`, коммит от
        `github-actions[bot]` с текстом `chore(tasks): Статусы задач`,
        `git push --force origin HEAD:refs/heads/task-board` через
        `${{ github.token }}`.
   - Над каждым шагом — комментарий «почему».
6. **`.github/workflows/pr-checks.yml`.** Шаг `claim-check` по образцу шага
   `diff-check` (T-0002): только для `task/T-*`, `!cancelled()`, с
   `git fetch origin "${{ github.base_ref }}"`.
7. **`tasks/README.md`:**
   - новый раздел `## Значки статуса` (на него ведут ссылки значков): таблица
     цветов; «значок — сигнал для людей, может отставать на 5–10 минут;
     защита — `pnpm task claim` и `claim-check` в CI»;
   - в «Как взять задачу» — брать, только когда у задачи значок «можно
     брать», и только через `pnpm task claim`;
   - в «Приёмке» — `claim-check` зелёный.
8. **`.claude/skills/take-task/SKILL.md`.** Шаг выбора: значок «можно брать» и
   `pnpm task claim`.
9. **`docs/09-ci-cd.md`:**
   - в таблицу или список workflow — `task-board.yml`: что делает, когда
     срабатывает, что пишет только в ветку `task-board`;
   - у `pr-checks` — шаг `claim-check`.
10. Гейт.

## Чего не трогаем

- Строки значков в файлах задач: их ставят тимлиды. Скрипт их только
  проверяет.
- Остальные workflow и ruleset.
- `scripts/release/*`.

## Тесты

Первым коммитом, в `scripts/test/tasks-*.test.ts`. Импорт `.mjs` — с
`@ts-expect-error` и причиной, как в T-0002.

1. **`statusBadge`** — по кейсу на каждую строку таблицы цветов. У
   заблокированной по трём зависимостям — `ждёт T-0003, T-0004 +1`. У
   «в работе» — `owner` без части после ` / `.
2. **`badgeLine`:**
   - задача без зависимостей → один значок;
   - с двумя → три значка в порядке `depends_on`.

   `validateTask`:
   - строки нет → ошибка;
   - строка с другим набором зависимостей → ошибка;
   - верная строка → без ошибок.
3. **`claim-check`** на наборе в памяти:
   - зависимость не `done` → отказ с её номером;
   - зона пересекается с задачей, у которой есть ветка → отказ с номером
     задачи;
   - пересечение с собственной зависимостью → не отказ;
   - задача `draft` → отказ;
   - всё в порядке → проходит.
4. **Реестр на настоящем репозитории** (кейс T-0002) остаётся зелёным со
   строками значков.

## Аналитика

Нет.

## Настройки и окружение

Нет. `GH_TOKEN` в workflow — встроенный `github.token`.

## Документы

`tasks/README.md`, `take-task`, `docs/09-ci-cd.md` — шаги 7–9.

## Критерии приёмки

- [ ] После захвата задачи её значок в течение ~10 минут становится «в работе · <аккаунт>», у задач с пересекающейся зоной — «зона занята». После мерджа — «готово», а у зависимых — «можно брать». Проверено на этой же задаче; снимки значков до и после — в PR.
- [ ] PR ветки задачи с несделанной зависимостью или занятой зоной не проходит `claim-check`. Проверено тестом и описано в PR.
- [ ] `pnpm task check` ловит строку значков, которая не совпадает с `depends_on`.
- [ ] Workflow пишет только в ветку `task-board`, новых actions нет, пины по SHA.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(ci): Живые значки статуса задач и проверка захвата`
- **Метка:** `release: patch` (область `ci`, `docs/09-ci-cd.md` §8.1)
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЖИВЫЕ ЗНАЧКИ СТАТУСА ЗАДАЧ**

  У каждой задачи в tasks/ под заголовком — цветные значки: можно брать, в работе, на ревью, ждёт другую задачу, готово. Они обновляются сами, а связанные задачи меняют значок, когда соседнюю берут или вливают. PR, взятый в обход порядка, теперь не пройдёт проверку в CI.
  ```
