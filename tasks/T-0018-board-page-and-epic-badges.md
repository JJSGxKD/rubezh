---
id: T-0018
title: Статусы задач в эпиках, страница доски и вклад по аккаунтам GitHub
epic: E0
priority: P1
status: ready
owner:
size: M
depends_on: []
zones:
  - scripts/tasks/**
  - scripts/test/tasks-*.test.ts
  - tasks/epics.md
  - tasks/README.md
  - tasks/_template.md
  - .claude/skills/task-spec/SKILL.md
shared:
  - docs/09-ci-cd.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0018. Статусы задач в эпиках, страница доски и вклад по аккаунтам GitHub

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0018.json)](README.md#значки-статуса)

## Зачем

Разработчик открывает `tasks/epics.md` и видит только номера задач: что
сделано и что можно взять, по ним не понять. Нужно, чтобы это было видно сразу,
без `pnpm task board`. Пользователь просил 06.10.2026:
- в эпиках отмечать, что задача выполнена и что её можно взять прямо сейчас;
- учитывать вклад разработчика с привязкой к аккаунту GitHub.

## Решения

- **В эпиках — живые значки, а не отметки руками.** Ячейка «Задачи» в
  `epics.md` — значки тех же `status/T-NNNN.json`, что под заголовками задач:
  «готово», «можно брать», «ждёт…». Отметка руками отстала бы от доски в
  первый же день.
- **Ячейку и строку значков пишет команда, а не человек.** Новая `pnpm task fix`
  ставит строку значков под заголовком каждой задачи и ячейку «Задачи» каждого
  эпика. `pnpm task check` сверяет их и при расхождении подсказывает
  `pnpm task fix`.
- **Страница доски — `README.md` ветки `task-board`.** Её пересчитывает тот же
  `pnpm task status-json`, что и значки; workflow не меняется: он и так кладёт
  в ветку весь каталог. GitHub показывает `README.md` при открытии ветки, адрес
  страницы — `https://github.com/JJSGxKD/rubezh/blob/task-board/README.md`.
- **Счётчик свободных задач.** Значок `status/free.json` («можно брать · 3
  задачи») стоит в начале `epics.md` и `tasks/README.md` и ведёт на страницу
  доски.
- **Вклад считается по автору влитого PR задачи.** PR ветки `task/T-NNNN` в
  `dev` — это его автор на GitHub. Автора PR ставит GitHub, а поле в файле
  может вписать кто угодно. Внутри аккаунта GitHub вклад раскладывается по полю
  `owner` («аккаунт / модель»). Так сессии ИИ под одним аккаунтом GitHub
  различаются.
- **Очки — сумма размеров сделанных задач:** `S` — 1, `M` — 2. Это наглядность,
  а не формула выплат: доли участников задаёт `docs/11-revenue-split.md`, и
  страница это прямо говорит.
- **На странице — только логины GitHub,** они и так видны у PR. Ни юзернеймов
  Telegram, ни почт из коммитов, ни имён.

## Как сейчас

- `tasks/epics.md` — таблица «Эпик | Цель | Приоритет | Задачи», последняя
  ячейка — номера через запятую: `T-0002, T-0011, T-0016` или `—`. Строка эпика
  узнаётся по `**E<число>.` в первой ячейке: `parseEpics`,
  `scripts/tasks/registry.mjs:15`.
- `checkRegistry(files, epicsMarkdown)` (`registry.mjs:83`) проверяет id,
  эпики, зависимости и циклы. Её зовут `pnpm task check` (`runCheck`,
  `task.mjs`) и тест реестра на настоящих файлах
  (`scripts/test/tasks-registry.test.ts:56`).
- `badgeLine(task, fileNames)` (`task-file.mjs:169`) собирает строку значков
  под заголовком. Значок зависимости:
  `[![T-0002](${STATUS_URL}/T-0002.json&label=T-0002)](T-0002-task-cli.md)`.
  `STATUS_URL` и `REPOSITORY` объявлены в `task-file.mjs` и не экспортируются.
- `badgeProblem` (`task-file.mjs:180`) ждёт строку значков сразу под «# T-NNNN. …».
- `statusBadge(entry)` (`board.mjs:136`) — JSON значка; `BADGE_CACHE_SECONDS = 300`
  (`board.mjs:120`) не экспортируется.
- `runStatusJson` (`task.mjs`) пишет `status/T-NNNN.json` на каждую задачу и
  `README.md` с тремя строками текста (`BOARD_README`).
- `ownerOf(task, true)` (`task.mjs`) читает `owner` из ветки задачи. Для
  сделанных задач `owner` уже лежит в файле на `dev`: исполнитель закрывает
  задачу коммитом со `status: done`, `owner` при этом остаётся.
- `openPrs()` (`git-io.mjs`) — `gh pr list --state open … --json number,headRefName,isDraft`.
  `null`, если `gh` нет или он не авторизован.
- Влитые сейчас: #205 (`task/T-0001`), #211 (`task/T-0002`), #213 (`task/T-0011`).
  Все — автор `Kennix88`, `owner` у всех — `claude-2 / sonnet-5.5`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Рефакторинг отдельным коммитом**, поведение не меняется:
   - `task-file.mjs`: экспортировать `REPOSITORY` и `STATUS_URL`; вынести
     `export function taskBadge(id, fileName)` → `[![${id}](${STATUS_URL}/${id}.json&label=${id})](${fileName})`;
     `badgeLine` зовёт его для зависимостей;
   - `board.mjs`: экспортировать `BADGE_CACHE_SECONDS`.
3. **`task-file.mjs` — `withBadgeLine(text, expected)`.** Возвращает текст файла
   с ровно одной строкой `expected` сразу под строкой заголовка `# T-NNNN. …`
   и одной пустой строкой после неё:
   - под заголовком (после пустых строк) уже стоит строка, начинающаяся с
     `[![статус](` → она заменяется на `expected`;
   - иначе `expected` вставляется под заголовком;
   - заголовка нет → текст без изменений: об этом скажет `pnpm task check`.

   Шапка, остальной текст и переводы строк файла (LF или CRLF) не меняются.
4. **Новый `scripts/tasks/epics.mjs`:**
   - `epicTasksCell(epicId, tasks)` → значки `taskBadge(id, fileName)` задач с
     `task.epic === epicId`, по возрастанию id, через пробел. Задач нет — `—`.
     Берутся задачи в любом статусе: значок сам скажет «черновик» или
     «отменено»;
   - `checkEpicCells(markdown, tasks)` → список ошибок. Для каждой строки
     эпика (тот же признак, что в `parseEpics`) последняя ячейка без пробелов
     по краям должна совпасть с `epicTasksCell`. Ошибка:
     `epics.md: эпик E1 — ячейка «Задачи» не совпадает с реестром, поправит pnpm task fix; ожидается: <ячейка>`;
   - `fixEpicCells(markdown, tasks)` → тот же текст, где в строках эпиков
     последняя ячейка заменена на `epicTasksCell` в виде `| <ячейка> |`.
     Другие строки и ячейки не трогаются.

   Последняя ячейка — текст между последней и предпоследней `|` строки.
5. **`registry.mjs`:** `checkRegistry` добавляет к ошибкам `checkEpicCells(epicsMarkdown, tasks)`.
   Подсказку `pnpm task fix` получает и сообщение `badgeProblem`: в конце
   «…; поправит pnpm task fix».
6. **Новая команда `pnpm task fix`** (`runFix` в `task.mjs`, строка в `USAGE`:
   `pnpm task fix  поставить строки значков и ячейки «Задачи» в эпиках`):
   - читает рабочую копию `tasks/`, как `runCheck`;
   - для каждого файла задачи с исправной шапкой — `withBadgeLine(text, badgeLine(data, fileNames))`;
     если у зависимости нет файла в реестре, файл пропускается;
   - `epics.md` — `fixEpicCells(text, tasks)`;
   - пишет только изменившиеся файлы, печатает `поправлено: tasks/…` по строке
     на файл или `Править нечего.`.
7. **`git-io.mjs` — `mergedTaskPrs()`:**
   `gh pr list --state merged --base dev --limit 1000 --json number,headRefName,author,mergedAt`.
   - Оставить записи, у которых `headRefName` совпадает с `^task\/T-\d{4}$`,
     `number` — число, `mergedAt` — строка. `author.login` — строка или его
     нет: удалённый аккаунт GitHub отдаёт `author: null`.
   - На выходе `[{ number, headRefName, login: string | null, mergedAt }]`.
     Если `gh` упал или ответ не массив — `null`, как в `openPrs`.
8. **Новый `scripts/tasks/board-page.mjs`, чистые функции:**
   - `SIZE_POINTS = { S: 1, M: 2 }`;
   - `freeBadge(count)` → `{ schemaVersion: 1, label: "можно брать", message, color, cacheSeconds: BADGE_CACHE_SECONDS }`:
     - `count === 0` → `message: "нет задач"`, `color: "lightgrey"`;
     - иначе `message` — `count` и «задача / задачи / задач» по русскому
       склонению (1, 21 — задача; 2–4, 22–24 — задачи; 5–20, 11–14, 25 —
       задач), `color: "brightgreen"`;
   - `taskCredits(doneEntries, mergedPrs)` → `Map<id, { login, pr, mergedAt, owner, points }>`:
     - `doneEntries` — колонка `done` из `classify`;
     - PR задачи — влитые с `headRefName === "task/" + id`; несколько — берётся
       самый поздний `mergedAt`;
     - PR нет или `mergedPrs === null` → `login`, `pr`, `mergedAt` — `null`;
     - `owner` — поле задачи, пустое → `"не указан"`;
     - `points` — `SIZE_POINTS[task.size]`;
   - `contributions(credits)` → массив людей
     `{ login, tasks, points, lastMergedAt, executors: [{ owner, tasks, points }] }`:
     - группировка по `login`, задачи без автора — одной группой с `login: null`;
     - люди — по убыванию `points`, затем `tasks`, затем `login` по алфавиту,
       `null` — последним;
     - исполнители внутри человека — в том же порядке, по `owner`;
   - `renderBoardPage({ board, owners, credits, people, githubAvailable, now })`
     → текст страницы, формат — раздел «Страница доски» ниже. `owners` —
     `Map<id, owner>` задач «в работе» и «на ревью», `now` — `Date`.
9. **`runStatusJson`:**
   - сверх `status/T-NNNN.json` пишет `status/free.json` — `freeBadge(board.free.length)`;
   - `README.md` — `renderBoardPage(…)` вместо `BOARD_README`;
   - `owners` — те же `ownerOf(…, true)`, что уже читаются для значков;
   - `credits` — `taskCredits(board.done, mergedTaskPrs())`;
   - `githubAvailable` — `mergedTaskPrs() !== null`. Вызов один, результат —
     в переменную;
   - `now` — `new Date()`.
10. **Репозиторий:**
    - запустить `pnpm task fix`: он перепишет ячейки `epics.md`. Строки значков
      в файлах задач уже верны (их сверяет `pnpm task check`), поэтому файлы
      `tasks/T-*.md` меняться не должны: их нет в зонах задачи. Поменялся хоть
      один — это вопрос тимлидам;
    - в `tasks/epics.md` под `# Эпики` и в `tasks/README.md` под первым
      заголовком — строка:

      ```md
      [![можно брать](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/free.json)](https://github.com/JJSGxKD/rubezh/blob/task-board/README.md) — [доска задач](https://github.com/JJSGxKD/rubezh/blob/task-board/README.md): что можно брать прямо сейчас, кто что делает, вклад
      ```
11. **Документы** — раздел «Документы».

## Страница доски

`renderBoardPage` выдаёт ровно это. Даты — UTC, `ДД.ММ.ГГГГ ЧЧ:ММ` и
`ДД.ММ.ГГГГ`. Ссылка на задачу —
`[T-0003. <title>](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/<fileName>)`,
символ `|` в заголовке экранируется как `\|`. Колонка пустая — вместо таблицы
строка `Пусто.`.

```md
# Доска задач

Обновлено 06.10.2026 10:48 UTC. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).

## Можно брать — 9

| Задача | Приоритет | Размер | Исполнитель | Эпик |
|---|---|---|---|---|
| [T-0003. …](…) | P0 | M | sonnet-5.5 · xhigh | E1 |

## В работе — 1

| Задача | Взял |
|---|---|
| [T-0012. …](…) | claude-3 / sonnet-5.5 |

## На ревью — 1

| Задача | PR |
|---|---|
| [T-0016. …](…) | [#215](https://github.com/JJSGxKD/rubezh/pull/215) |

## Ждут — 3

| Задача | Чего ждёт |
|---|---|
| [T-0004. …](…) | ждёт T-0003 |

## Готово — 3

| Задача | Сделал | PR |
|---|---|---|
| [T-0011. …](…) | @Kennix88 · claude-2 / sonnet-5.5 | [#213](https://github.com/JJSGxKD/rubezh/pull/213) |

## Вклад

Очки — сумма размеров сделанных задач: S — 1, M — 2. Это наглядность, а не формула выплат: доли участников — `docs/11-revenue-split.md`.

| GitHub | Задач | Очков | Последний мердж |
|---|---|---|---|
| [@Kennix88](https://github.com/Kennix88) | 3 | 5 | 06.10.2026 |

| GitHub | Исполнитель | Задач | Очков |
|---|---|---|---|
| @Kennix88 | claude-2 / sonnet-5.5 | 3 | 5 |
```

Подробности:
- **«Можно брать», «В работе», «На ревью», «Ждут»** — в порядке `classify`.
  «Готово» — по убыванию id, свежие сверху.
- **«Взял»** — `owners.get(id)`; пусто — `неизвестно`.
- **«Чего ждёт»** — `entry.reason`, как в `pnpm task board`.
- **«Сделал»:**
  - автор PR есть — `@login · owner`;
  - автора нет — только `owner`;
  - PR нет — в колонке PR `—`.
- **Задача без автора PR:** в «Вкладе» её строка — `без PR задачи` вместо
  логина, без ссылки, «Последний мердж» — `—`.
- **`githubAvailable === false`:** вместо таблиц «Вклада» строка
  `Нет данных GitHub: список влитых PR не получен.`
- Черновики и отменённые на странице не показываются.

## Чего не трогаем

- `.github/workflows/task-board.yml`: его меняет T-0016, а этой задаче правка
  не нужна.
- `statusBadge`, `classify`, `claim`, `claim-check`, `diff-check`.
- Формат строки значков под заголовком: `badgeLine` остаётся тем же, меняется
  только то, кто её ставит.

## Тесты

Первым коммитом. Файлы — `scripts/test/tasks-epics.test.ts`,
`scripts/test/tasks-board-page.test.ts`, дополнения в `tasks-file.test.ts` и
`tasks-registry.test.ts`.

- `taskBadge` — `("T-0002", "T-0002-task-cli.md")` → строка с
  `status/T-0002.json&label=T-0002` и ссылкой на файл; `badgeLine` после
  рефакторинга даёт прежнюю строку (снимок одной задачи с двумя зависимостями).
- `withBadgeLine`:
  - строка значков есть и устарела → заменена, остальное побайтно то же;
  - строки нет → вставлена под заголовком, после неё пустая строка;
  - файл с CRLF → переводы строк остались CRLF;
  - заголовка нет → текст без изменений.
- `epicTasksCell`:
  - три задачи эпика в порядке `T-0011, T-0002, T-0016` → значки по возрастанию id;
  - задач нет → `—`;
  - задача чужого эпика не попадает.
- `checkEpicCells`:
  - совпадает → `[]`;
  - номера через запятую, как сейчас → ошибка с эпиком и ожидаемой ячейкой;
  - пробелы по краям ячейки не считаются расхождением.
- `fixEpicCells` → после него `checkEpicCells` пуст; строки вне таблицы и
  ячейки «Цель» и «Приоритет» не изменились.
- `checkRegistry` — расхождение ячейки эпика попадает в ошибки реестра.
- `freeBadge`:
  - `0` → `нет задач`, `lightgrey`;
  - `1` → `1 задача`;
  - `3` → `3 задачи`;
  - `5` → `5 задач`;
  - `11` → `11 задач`;
  - `21` → `21 задача`;
  - `22` → `22 задачи`;
  - у всех `brightgreen`, кроме нуля.
- `taskCredits`:
  - один PR → его автор и номер;
  - два влитых PR одной задачи → самый поздний;
  - PR нет → `login: null`;
  - `mergedPrs === null` → у всех `login: null`;
  - `owner` пустой → `не указан`;
  - `S` → 1 очко, `M` → 2.
- `contributions`:
  - двое: у одного больше очков → первый;
  - равные очки → больше задач;
  - всё равно → по логину;
  - `null` последним;
  - исполнители внутри человека сгруппированы по `owner`.
- `renderBoardPage` — снимок страницы целиком (`toMatchInlineSnapshot` или
  строка-эталон в тесте) на наборе:
  - по задаче в каждой колонке;
  - одна сделанная без PR;
  - `now = new Date("2026-10-06T10:48:00Z")`;
  - пустая колонка → `Пусто.`;
  - `githubAvailable: false` → строка «Нет данных GitHub…»;
  - `|` в заголовке задачи экранирован.

## Аналитика

Нет: инструменты команды, до игрока не доходят.

## Настройки и окружение

Нет. `gh` в workflow уже авторизован `GH_TOKEN`, права `pull-requests: read`
уже есть.

## Документы

- `tasks/README.md`, раздел «Значки статуса»:
  - абзац «Строка значков в файле задачи статична. Её ставят тимлиды…»
    переписать: строку ставит `pnpm task fix`, `pnpm task check` её сверяет;
  - добавить абзац «В эпиках»: ячейка «Задачи» в `epics.md` — те же живые
    значки; её тоже ставит `pnpm task fix`;
  - добавить абзац «Доска»: страница `README.md` ветки `task-board` — что на
    ней, значок `free.json`, раздел «Вклад» и правило очков со ссылкой на
    `docs/11-revenue-split.md`.
- `tasks/README.md`, «Как взять задачу», шаг 1: «Свободные — на доске задач
  (ссылка) или `pnpm task next`».
- `tasks/_template.md`: поясняющую строку под строкой значков заменить на
  «Строку значков и ячейку эпика ставит `pnpm task fix`. Эту поясняющую строку
  при копировании удалить».
- `.claude/skills/task-spec/SKILL.md`, шаг 5, пункт 3: вместо «Добавить `id` в
  строку эпика» — «Запустить `pnpm task fix`: он поставит строку значков и
  ячейку эпика; затем `pnpm task check`».
- `docs/09-ci-cd.md`, строка `task-board.yml` в таблице workflow: дописать, что
  тот же прогон пишет значок `status/free.json` и страницу доски `README.md`
  с разделом «Вклад».

## Критерии приёмки

- [ ] В `tasks/epics.md` ячейка «Задачи» каждого эпика — значки, на GitHub
  они показывают статусы.
- [ ] `pnpm task check` падает, если ячейка эпика или строка значков не
  совпадает с реестром, и подсказывает `pnpm task fix`; после `pnpm task fix`
  проходит.
- [ ] `pnpm task status-json --out <каталог>` локально (с авторизованным `gh`)
  пишет `status/free.json` и `README.md` по формату «Страницы доски».
  Содержимое страницы — в описании PR.
- [ ] На странице — только логины GitHub, никаких почт и юзернеймов Telegram.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.
- [ ] После мерджа страница `task-board/README.md` на GitHub показывает доску.
  Это проверяют тимлиды.

## PR

- **Заголовок:** `feat(dev): Статусы в эпиках, доска и вклад по GitHub`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОСКА ЗАДАЧ И ВКЛАД**

  Что можно взять прямо сейчас, теперь видно сразу. В эпиках вместо номеров — живые значки статуса. Есть страница доски со всеми задачами по колонкам и вкладом каждого аккаунта GitHub.

  🗂 **Что появилось**

  • tasks/epics.md: у каждой задачи значок — «готово», «можно брать», «ждёт…»
  • доска — README ветки task-board: можно брать, в работе, на ревью, ждут, готово
  • раздел «Вклад»: сделанные задачи и очки по автору PR на GitHub, внутри — по исполнителям; очки — для наглядности, не для выплат
  • pnpm task fix сам ставит строки значков и ячейки эпиков — руками их больше не пишут
  ```
