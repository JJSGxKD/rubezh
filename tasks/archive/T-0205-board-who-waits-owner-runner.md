---
id: T-0205
title: Доска — кто кого ждёт, вид `owner` и счётчики сверху
epic: E0
priority: P1
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: [T-0204]
zones:
  - scripts/tasks/task-file.mjs
  - scripts/tasks/board.mjs
  - scripts/tasks/board-page.mjs
  - scripts/tasks/git-io.mjs
  - scripts/tasks/task.mjs
  - scripts/test/tasks-file.test.ts
  - scripts/test/tasks-board.test.ts
  - scripts/test/tasks-board-page.test.ts
shared:
  - tasks/README.md
  - .claude/skills/take-task/SKILL.md
  - .claude/skills/review-pr/SKILL.md
  - .claude/skills/task-spec/SKILL.md
  - AGENTS.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0205. Доска — кто кого ждёт, вид `owner` и счётчики сверху

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0205.json)](../README.md#значки-статуса) [![T-0204](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0204.json&label=T-0204)](T-0204-tasks-archive-folder.md)

## Зачем

Сейчас по доске не понять, что ждёт тимлида, а что — владельца: PR с
вопросом, PR, готовый к приёмке, и PR с красным CI стоят одной колонкой «На
ревью». Задачи, которые можно сделать только на машине владельца, смешаны с
теми, которым хватит любого Docker. После задачи вверху доски — строка
счётчиков и два раздела: «Ждут владельца» и «Ждут тимлида». Свободные
задачи разложены по тому, где их можно делать.

## Решения

Решения владельца от 24.10.2026 (разбор входящих, вопросы В2 и В7):

- **Новый вид `runner: owner`** — задачу можно сделать только на машине
  владельца: прод, настоящие секреты, телефон, бот в Telegram. `local` —
  по-прежнему любая машина с Docker. Нынешние задачи вид не меняют: среди
  открытых `local` таких, что требуют машину владельца, нет.
- **Раздел «Ждут владельца»** — свободные задачи `owner` и `human`, а также
  PR с меткой «ждёт владельца». Метку ставит и снимает тимлид, когда PR
  нужно решение или действие владельца (секрет, прод, проверка на
  телефоне, вопрос продукта).
- **Раздел «Ждут тимлида»** — PR задач, которые ждут тимлида: черновик с
  разделом `## Вопросы` («вопрос») или открытый PR без метки «доработка» и
  без красного CI («приёмка»). Раздел — выше остальных, чтобы тимлид начинал
  день с него.
- **Строка счётчиков** под заголовком: «Свободно 12 · в работе 3 · на ревью 4
  · на доработке 2 · ждут тимлида 3 · ждут владельца 1 · влито сегодня 5 ·
  пачка 2: осталось 14». «Сегодня» — по Москве (решение В5): сутки с 00:00
  МСК. Пачка — ближайшая, в которой есть невыполненные задачи; «осталось» —
  её задачи не в `done` и не в `cancelled`.
- **«Можно брать» — тремя таблицами** по виду: «В облаке» (`any`), «Машина с
  Docker» (`local`), «Машина владельца» (`owner`). `human` в «Можно брать»
  не показывается — он в «Ждут владельца».

Решения `claude-lead-1` от 24.10.2026:

- **Кого ждёт PR — одна функция** `waitingOn(pr)` в `board.mjs`, порядок
  проверок: метка «ждёт владельца» → `owner`; метка «доработка» → `executor`;
  черновик с `## Вопросы` в описании → `lead` («вопрос»); черновик без
  вопросов → `executor`; красный CI → `executor`; иначе → `lead`
  («приёмка»). Её же потом возьмёт столбец «Чего ждёт» (T-0206).
- **Красный CI** — в `statusCheckRollup` PR есть проверка `CheckRun` с
  `conclusion` из `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`
  или статус `StatusContext` с `state` `FAILURE` или `ERROR`. Идущие
  проверки (`conclusion` пусто) красными не считаются.
- **Время на странице — МСК.** «Обновлено 24.10.2026 05:40 МСК» вместо UTC.
  Москва — UTC+3 без перехода на летнее время; пересчёт — сдвигом на три
  часа, без библиотек поясов. Помощники `moscowDay(date)` → `YYYY-MM-DD` и
  `formatMoscow(date)` экспортируются: ими же пользуется «Вклад» (T-0208).
- `pnpm task next --runner owner` показывает `any`, `local` и `owner`;
  `--runner local` — `any` и `local`, как сейчас. В «Потоках сейчас» поток
  `owner` подписан «· owner».

## Как сейчас

- `scripts/tasks/task-file.mjs:26` — `RUNNERS = ["any", "local", "human"]`;
  проверка поля — строка 355.
- `scripts/tasks/board.mjs:136–144` — `nextTasks`: `local` включает `any`,
  `human` — никогда. Строки 196–197 — `STREAM_RUNNERS = ["any", "local"]`;
  `streamLabel` (269–272) и `streamShortLabel` (275–278) помечают только
  `local`.
- `scripts/tasks/board.mjs:66–127` — `classify` раскладывает задачи; PR
  берутся из `prs` с полями `number, headRefName, isDraft, labels`.
- `scripts/tasks/git-io.mjs:63–77` — `openPrs()`: `gh pr list --json
  number,headRefName,isDraft,labels`.
- `scripts/tasks/board-page.mjs:91–97` — `formatDate`/`formatDateTime` в UTC;
  `renderBoardPage` (154–189) — разделы по порядку: потоки, доработка, можно
  брать, в работе, на ревью, ждут, готово, вклад; вступление «Обновлено … UTC».
- `scripts/tasks/task.mjs:396–425` — `runStatusJson` собирает страницу;
  `mergedTaskPrs()` уже даёт `mergedAt` влитых PR задач.
- `tasks/README.md`, «Поля задачи» — строка `runner`; «Как взять задачу» —
  про `runner: human`; «Автопоток» — про `--runner local`.

## Шаги по порядку

1. **`task-file.mjs`.** `RUNNERS = ["any", "local", "owner", "human"]`.
2. **`board.mjs`.**
   - `export const OWNER_LABEL = "ждёт владельца";`
   - `nextTasks`: `runner` `owner` → `["any", "local", "owner"]`, `local` →
     `["any", "local"]`, остальное → `["any"]`.
   - `STREAM_RUNNERS = ["any", "local", "owner"]`; `streamLabel` и
     `streamShortLabel` помечают `owner` так же, как `local`: «· owner» и
     «·owner».
   - `export function isCiRed(pr)` — по правилу из «Решений»;
     `statusCheckRollup` нет или не массив — `false`.
   - `export function waitingOn(pr)` → `{ who: "owner" | "lead" | "executor",
     why: "решение владельца" | "вопрос" | "приёмка" | "доработка" | "черновик" | "CI красный" }`
     по порядку из «Решений». Вопросы — строка `## Вопросы` в начале строки
     описания.
   - `classify` кладёт в запись «На ревью» и «Доработки» поле `waiting` —
     результат `waitingOn`. Черновики PR задач (`isDraft`) сейчас не
     попадают в `openPrs` карты — теперь черновик тоже отображается в «На
     ревью» с `waiting` («вопрос» или «черновик»); колонка «В работе» —
     только ветка без PR.
   - `export function boardCounters(board, mergedPrs, now)` → `{ free,
     inProgress, review, rework, waitLead, waitOwner, mergedToday, batch:
     { number, left } | null }`. `waitLead` — записи с `waiting.who ===
     "lead"`, `waitOwner` — PR с `owner` плюс свободные `owner` и `human`.
     `mergedToday` — влитые PR задач, у которых `moscowDay(mergedAt) ===
     moscowDay(now)`.
3. **`git-io.mjs`.** `openPrs()` запрашивает ещё `body,createdAt,statusCheckRollup`.
4. **`board-page.mjs`.**
   - `moscowDay(date)` и `formatMoscow(date)` → «24.10.2026 05:40»; даты
     «Готово» и «Вклада» — по Москве.
   - Вступление: «Обновлено 24.10.2026 05:40 МСК. …», под ним строка
     счётчиков из `boardCounters`: числа через « · », пачки нет —
     последнего пункта нет.
   - Разделы в порядке: «Ждут владельца» (столбцы «Что», «Почему»:
     задача или PR, «решение владельца» или «машина владельца» / «нужен
     человек»), «Ждут тимлида» (столбцы «PR», «Задача», «Почему»: «вопрос»
     или «приёмка»), «Потоки сейчас», «Доработка», «Можно брать», «В
     работе», «На ревью», «Ждут», «Готово», «Вклад».
   - «Можно брать» — заголовок раздела с общим числом и три подзаголовка
     `### В облаке — N`, `### Машина с Docker — N`, `### Машина владельца —
     N`; пустая таблица — «Пусто.».
   - Ссылка `#потоки-сейчас` из `epics.md` по-прежнему ведёт на раздел
     потоков: заголовок «## Потоки сейчас» не меняется.
5. **`task.mjs`.** `USAGE` и разбор `--runner` — значение `owner`;
   `runStatusJson` передаёт в страницу `mergedPrs` для счётчиков.
6. **Документы:**
   - `tasks/README.md`: в «Поля задачи» — `owner` в строке `runner` с
     определением из «Решений»; в «Автопоток» — `--runner owner` для
     потоков на машине владельца; в «Приёмка» — абзац про метку «ждёт
     владельца»: кто ставит, когда снимать; в «Значки статуса», если там
     перечислены разделы доски, — новые разделы;
   - скилл `review-pr`, «Исход» — строка: «нужно решение или действие
     владельца — метка «ждёт владельца», снять после ответа»;
   - скилл `task-spec`, шаг 3 — `runner` `owner` в списке честных видов;
   - скилл `take-task` и `AGENTS.md` — `--runner owner` рядом с
     `--runner local`.

## Чего не трогаем

- Значки статуса задач (`statusBadge`) и `free.json`: их формат не меняется.
- Раздел «Вклад» — задача T-0208.
- Столбцы разделов «В работе» и «На ревью» — задача T-0206.
- Метки на GitHub: «ждёт владельца» тимлид заводит руками при первой
  надобности; скрипт её не создаёт.

## Тесты

Первым коммитом.

- `tasks-file.test.ts` — `runner: owner` проходит проверку,
  `runner: robot` — ошибка с перечнем четырёх видов.
- `tasks-board.test.ts`:
  - `nextTasks` с `runner: "owner"` берёт `any`, `local` и `owner`, без
    `human`; с `local` — без `owner`;
  - `waitingOn`: метка «ждёт владельца» вместе с «доработкой» → `owner`;
    «доработка» → `executor`; черновик с `## Вопросы` → `lead`/«вопрос»;
    черновик без вопросов → `executor`/«черновик»; открытый PR с
    `CheckRun` `FAILURE` → `executor`/«CI красный»; открытый PR с
    `conclusion: null` → `lead`/«приёмка»;
  - `isCiRed`: `StatusContext` `ERROR` → `true`; пустой список → `false`;
  - `boardCounters`: PR, влитый в 23:30 UTC 23.10 (02:30 МСК 24.10), при
    `now` 24.10 10:00 МСК — «влито сегодня» 1; влитый в 20:00 UTC 23.10 —
    0; пачка 2 с тремя открытыми задачами при сделанной пачке 1 →
    `{ number: 2, left: 3 }`; всё сделано → `batch: null`;
  - поток `owner` в `streamsSummary` есть и подписан «· owner».
- `tasks-board-page.test.ts`:
  - вступление — «МСК», строка счётчиков на месте;
  - «Ждут тимлида» стоит перед «Потоки сейчас», в нём PR с вопросом и PR к
    приёмке; PR с красным CI туда не попадает;
  - «Ждут владельца» показывает свободную задачу `owner` и PR с меткой;
  - «Можно брать» — три подраздела, задача `local` — во втором, `human` —
    ни в одном.

## Аналитика

Нет: инструмент команды.

## Настройки и окружение

Нет. Метка «ждёт владельца» на GitHub — руками тимлида.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] `runner: owner` проходит `pnpm task check`; `pnpm task next --runner
  owner` показывает задачи всех трёх машинных видов.
- [ ] На странице доски время — МСК, вверху строка счётчиков, затем «Ждут
  владельца» и «Ждут тимлида».
- [ ] Черновик с вопросами — в «Ждут тимлида», PR с красным CI — нет.
- [ ] «Можно брать» разложено по трём видам.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(dev): Доска — кто кого ждёт и счётчики`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОСКА: КТО КОГО ЖДЁТ И СЧЁТЧИКИ**

  Вверху доски — строка счётчиков и два раздела: «Ждут владельца» (задачи для машины владельца и PR с меткой «ждёт владельца») и «Ждут тимлида» (вопросы и PR к приёмке). Свободные задачи разложены по месту: облако, машина с Docker, машина владельца. Появился вид задачи `runner: owner`. Время на доске — по Москве.
  ```
