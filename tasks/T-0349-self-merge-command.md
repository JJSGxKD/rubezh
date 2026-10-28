---
id: T-0349
title: Самостоятельный мердж — поле merge в задаче, команды pnpm task merge и pnpm task holds, правила для потоков
epic: E0
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - scripts/tasks/task-file.mjs
  - scripts/tasks/merge.mjs
  - scripts/tasks/task.mjs
  - scripts/test/tasks-file.test.ts
  - scripts/test/tasks-merge.test.ts
  - tasks/_template.md
shared:
  - scripts/tasks/zones.mjs
  - scripts/tasks/git-io.mjs
  - scripts/test/tasks-zones.test.ts
  - tasks/README.md
  - .claude/skills/take-task/SKILL.md
  - .claude/skills/review-pr/SKILL.md
  - .claude/skills/task-spec/SKILL.md
  - AGENTS.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 3
---

# T-0349. Самостоятельный мердж — поле merge в задаче, команды pnpm task merge и pnpm task holds, правила для потоков

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0349.json)](README.md#значки-статуса)

## Зачем

Сейчас каждый PR задачи вливает тимлид, и очередь приёмки — узкое место:
простые задачи (документы, данные контента, рефакторинг без смены поведения)
ждут той же проверки, что деньги и миграции. Владелец решил (Р176): задачу,
помеченную тимлидом, исполнитель вливает сам — после самопроверки по скиллу
`review-pr`, зелёного CI и команды, которая проверяет всё это за него. Вторая
часть Р176 — что исполнитель решает сам — уже записана в `tasks/README.md`,
раздел «Что исполнитель решает сам»; для неё нужна команда, которая скажет,
держит ли файл задача «в работе».

## Решения

Решение владельца **Р176** (`docs/35-stage4-plan.md`, 28.10.2026), детали —
`claude-lead-1`:

1. **Поле шапки `merge`**: `self` или `lead`; нет поля — `lead` (старые задачи
   не правятся). Ставит тимлид в спецификации.
2. **`merge: self` запрещён проверкой реестра** (`pnpm task check`), если у
   задачи: `effort: extra`; `runner: owner` или `human`; в `zones` или
   `shared` путь, совпадающий с одним из шаблонов
   `SELF_MERGE_FORBIDDEN` — `backend/api/prisma/**`,
   `backend/api/src/modules/{payments,wallet,shop,auth,ads,referrals,partners,restrictions,roles,secrets,antifraud,runs}/**`,
   `backend/api/src/platforms/**`, `infra/**`, `.github/**`,
   `packages/app-shell/src/screens/**`, `apps/web-*/**`, `packages/adapter-*/**`.
   Текст ошибки: «merge: self — только для задач без денег, авторизации,
   миграций, конкурентности, антифрода, прода и экранов игрока (Р176): <что
   мешает>». Это страховка, а не замена суждения тимлида.
3. **Пометку читают из `origin/dev`**, а не из ветки PR: исполнитель не может
   выдать её себе сам, дописав поле в своей ветке.
4. **Самопроверка** — комментарий в PR от потока: первая строка
   `**<кодовое имя потока>:** самопроверка по review-pr`, строка
   `head: <полный SHA головы PR>`, чек-лист «Приёмки» из `tasks/README.md`
   отмеченный целиком (`- [x]`); ни одной `- [ ]`.
5. **`pnpm task merge T-NNNN`** вливает PR задачи, только если всё сходится
   (раздел «Шаги», п. 4); иначе — код 1 и список причин. Вливает
   merge-коммитом с `--match-head-commit`: пуш между проверкой и мерджем
   мердж отменит.
6. **`pnpm task holds <путь>`** печатает задачи «в работе» и «доработка»,
   у которых путь попадает в `zones` или `shared`, с номером PR; пусто —
   «Файл не держит ни одна задача в работе».
7. **Тимлид** каждый заход выборочно читает PR, влитые самими потоками (их
   отличает комментарий самопроверки), и при дефекте откатывает revert-PR или
   заводит задачу.

## Как сейчас

- `scripts/tasks/task-file.mjs:25–56` — перечни значений, `FIELDS`,
  `OPTIONAL_FIELDS`; проверка полей — `validateTask` (стр. ~375–400).
- `scripts/tasks/task.mjs:20–36` — `USAGE`; разбор команд — `main` (стр. ~515);
  образец команды с `gh` и проверками — `runResume` (стр. 298).
- `scripts/tasks/git-io.mjs:73–100` — `openPrs` (`OPEN_PRS_LIMIT = 40`,
  поля `number,headRefName,isDraft,labels,body,createdAt,statusCheckRollup,commits`);
  `readBranchFile`, `fetchOrigin`.
- `scripts/tasks/board.mjs` — `classify`, колонки «В работе», «Доработка»;
  `prStatus` и метки статуса (Р172).
- `scripts/tasks/zones.mjs` — `matches(path, globs)`, `outOfZone`.
- `tasks/README.md`: таблица полей шапки (стр. ~85–100), «Цикл потока»
  п. 10 «Не вливать самому» (стр. ~439), «Приёмка» (стр. ~676),
  «Что исполнитель решает сам».
- Скиллы: `take-task` («Не вливать PR…», стр. ~101), `review-pr` («Мердж
  (только тимлиды)», стр. ~84), `task-spec` (шаг 3 «Нарезка»).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красные.
2. **`task-file.mjs`**: `MERGES = ["self", "lead"]`; поле `merge` в `FIELDS`
   после `release`, в `OPTIONAL_FIELDS`; `expectEnum("merge", MERGES)`;
   `SELF_MERGE_FORBIDDEN` (п. 2 «Решений») и проверка `merge: self` с текстом
   ошибки оттуда. Сопоставление путей — `matches` из `zones.mjs`.
3. **`tasks/_template.md`** — строка `merge: lead` после `release`.
4. **`merge.mjs`** (новый) — чистая функция `mergeProblems({ task, pr, mergeable, comments, headSha })`
   → список причин отказа и команда `runMerge`:
   - задача из `origin/dev` (`readBranchFile` по `origin/dev`), `merge: self`;
     в ветке PR файл задачи — `status: done`;
   - PR ветки `task/T-NNNN` открыт, не черновик, метка статуса ровно
     «на ревью»;
   - все проверки `statusCheckRollup`, кроме `board`, — `SUCCESS`,
     `SKIPPED` или `NEUTRAL`; нет незавершённых;
   - `mergeable` — `MERGEABLE` (`gh pr view --json mergeable`; `UNKNOWN` —
     одна повторная попытка через 10 с, затем отказ);
   - есть комментарий самопроверки (п. 4 «Решений») с `head:` равным
     текущему SHA головы;
   - всё сошлось — `gh pr merge <N> --merge --match-head-commit <SHA>`;
     печать «PR #N влит» и раздел `## Сводка для команды` из описания.
   Каждый вызов `gh` — с таймаутом (как в `git-io.mjs`).
5. **`pnpm task holds <путь>`** — в `task.mjs` через `loadBoard`: задачи
   колонок «В работе» и «Доработка», чьи `zones`/`shared` совпадают с путём.
6. **`task.mjs`** — обе команды в `USAGE` и `main`.
7. **Документы и скиллы** (раздел «Документы»).

## Чего не трогаем

- Ботов меток (`pr-status-label.yml`, `pr-check.mjs`) и `claim`/`resume`.
- Мердж тимлидами: он остаётся как был для всех задач без `merge: self`.
- Уборку архива: закрытые потоком задачи переносит та же уборка тимлида.

## Тесты

- `scripts/test/tasks-file.test.ts`: `merge` необязателен; `self`/`lead`
  проходят, другое — ошибка; `merge: self` с `effort: extra`, с
  `runner: owner`, с зоной `backend/api/prisma/migrations/**`, с зоной в
  `packages/app-shell/src/screens/` — ошибка с причиной; с зонами в
  `docs/` и `packages/core-game/src/content/` — проходит.
- `scripts/test/tasks-merge.test.ts` (чистая `mergeProblems`, без сети):
  - всё сходится — причин нет;
  - `merge: lead` в `dev` при `merge: self` в ветке — отказ «пометка —
    из dev»;
  - черновик, метка «в работе», две метки статуса — отказ;
  - `gate` красный или идёт — отказ; красный `board` — не помеха;
  - `CONFLICTING` — отказ;
  - нет самопроверки, в ней `- [ ]`, `head:` не совпадает с головой — отказ;
  - в ветке `status: in-progress` — отказ.
- `scripts/test/tasks-zones.test.ts` (если `holds` опирается на новый
  помощник в `zones.mjs`): путь в зонах задачи «в работе» найден, в зонах
  `ready` — нет.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `tasks/README.md`:
  - таблица полей шапки — строка `merge` (`self` · `lead`, по умолчанию
    `lead`, ставит тимлид, запреты — п. 2 «Решений»);
  - новый раздел «Самостоятельный мердж» после «Что исполнитель решает сам»:
    когда (`merge: self` в `dev`), порядок (гейт → PR «на ревью» → CI →
    самопроверка по `review-pr` комментарием с `head:` → `pnpm task merge`),
    что делает тимлид (выборочное чтение влитого каждым заходом, откат);
  - «Цикл потока», п. «Не вливать самому» — «кроме задач с `merge: self`:
    раздел «Самостоятельный мердж»»;
  - раздел «Что исполнитель решает сам», п. 2 — проверка файла командой
    `pnpm task holds <путь>` вместо поиска по доске.
- `.claude/skills/take-task/SKILL.md` — шаг самомерджа после PR и правка
  «Не вливать PR…».
- `.claude/skills/review-pr/SKILL.md` — режим «самопроверка»: кто, формат
  комментария; раздел «Мердж (только тимлиды)» — «и потоки по `merge: self`».
- `.claude/skills/task-spec/SKILL.md`, шаг 3 «Нарезка» — когда ставить
  `merge: self` (п. 2 «Решений») и что по умолчанию `lead`.
- `AGENTS.md` — строка «PR вливают тимлиды, исполнитель — никогда» →
  «…кроме задач с `merge: self`».
- `CLAUDE.md`, «Как работаем», п. 4 — «PR в `dev`; вливает тимлид, а задачу
  с `merge: self` — сам поток после самопроверки (Р176)».

## Критерии приёмки

- [x] `merge` проверяется реестром, запреты из п. 2 «Решений» ловятся с причиной.
- [x] `pnpm task merge` берёт пометку из `origin/dev` и отказывает по каждому условию п. 4 «Шагов» с понятной причиной.
- [x] Мердж — merge-коммитом с `--match-head-commit`.
- [x] `pnpm task holds` находит задачи «в работе» и «доработка» по пути.
- [x] Документы и скиллы описывают новый порядок; старые задачи без поля не тронуты.

## PR

- **Заголовок:** `feat(dev): Самостоятельный мердж задач с merge: self`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  🚦 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОТОКИ ВЛИВАЮТ ПРОСТЫЕ ЗАДАЧИ САМИ**

  Задачу с пометкой тимлида `merge: self` поток вливает сам: самопроверка по `review-pr` комментарием в PR, зелёный CI и `pnpm task merge`, который проверяет пометку в `dev`, метку, проверки, самопроверку и голову PR (Р176). Пометку нельзя поставить задачам с деньгами, авторизацией, миграциями, конкурентностью, антифродом, продом и экранами игрока — это ловит `pnpm task check`. Новая команда `pnpm task holds <путь>` говорит, держит ли файл задача в работе.
  ```
