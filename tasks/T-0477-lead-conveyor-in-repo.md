---
id: T-0477
title: Конвейер тимлида в репозитории — поезд мерджей, статус, ожидание работы и сценарий
epic: E0
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - scripts/lead/**
  - .claude/workflows/**
  - scripts/test/lead-conveyor.test.ts
shared:
  - .gitignore
  - tasks/README.md
  - docs/09-ci-cd.md
runner: local
executor: sonnet-5.5
effort: high
release: patch
merge: lead
design: null
batch: 5
---

# T-0477. Конвейер тимлида в репозитории — поезд мерджей, статус, ожидание работы и сценарий

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0477.json)](README.md#значки-статуса)

## Зачем

С 12.11.2026 PR вливает «поезд мерджей»: одобренные PR проверяются пачкой
поверх свежего `dev` одним прогоном CI, красная пачка делится пополам до
виновника, конфликт освежает ветку без ожидания. Ревью и задачи ведёт
сценарий конвейера на шесть линий. Всё это живёт во **временной папке
сессии тимлида** и пропадёт вместе с ней. Задача (Р224, E) переносит
конвейер в репозиторий: любой тимлид и следующая сессия поднимают его
одной командой.

## Решения

- `docs/35-stage4-plan.md`, **Р224** (E).
- Исходники (рабочие версии с 13.11.2026) лежат на машине тимлида в
  `D:/root/temp/claude/79bdbda1a99f2744/a3025a8c-b887-45c5-ad0c-894b5ae74d93/scratchpad/lead-import/`:
  `merge-train.sh` (поезд), `merge-queue.sh` (вливание по одному),
  `wait-checks.sh`, `wait-work.sh`, `train-status.js`, `test-env.sh`,
  `wf-running.js`, `pipeline.workflow.js` (сценарий Workflow).
- **Перенос — адаптация**: убрать абсолютные пути (корень репозитория — из
  `git rev-parse --show-toplevel`, состояние — `.lead/` в корне, в
  `.gitignore`), параметры — флагами и переменными, без секретов и
  адресов. Поведение — то же.
- Сценарий конвейера — в `.claude/workflows/pipeline.js` (сохранённые
  сценарии Workflow): тимлид запускает его по имени с аргументами
  (`lanes`, `maxTasks`, `priority`, `exclude`, `skipPrs`, `seeds`).
- В сценарии — приём **G** Р224: PR с `effort: extra` проверяют два
  ревьюера с разными линзами (корректность и безопасность); замечания
  объединяются, блокирует любое.

## Как сейчас

- Описание поезда — только в переписке тимлида; в `tasks/README.md` — старый
  `merge-queue` вручную.

## Шаги по порядку

1. `scripts/lead/`: `train.sh` (из `merge-train.sh`), `merge-one.sh`
   (из `merge-queue.sh`), `wait-checks.sh`, `wait-work.sh`,
   `train-status.mjs`, `test-env.sh`, `workflow-running.mjs`; общий
   `paths.sh`/`paths.mjs` — корень, `.lead/`, рабочая копия поезда
   `.claude/worktrees/train`.
2. `.lead/` в `.gitignore`: очередь, итоги, провалы, лог поезда.
3. `.claude/workflows/pipeline.js` — из `pipeline.workflow.js`: пути — из
   аргументов или корня; приём G (два ревьюера при `extra`).
4. `tasks/README.md` — раздел «Конвейер тимлида»: как запустить поезд и
   сценарий, где состояние, как читать провалы; `docs/09-ci-cd.md` §8 —
   абзац «Поезд мерджей»: правило свежести `dev` выполняется проверкой
   итогового состояния пачки.
5. `scripts/test/lead-conveyor.test.ts`: `train-status` по образцовым
   файлам очереди, итогов и провалов (повторная постановка после провала,
   устаревшие строки `0 …`); разбор итога CI по последнему прогону каждого
   имени (`ci_of` — вынести в `train-status.mjs` как функцию).

## Чего не трогаем

- CI и правила веток: поезд вливает обычным `gh pr merge --merge`.

## Сценарий и интерфейс

- Тимлид: `bash scripts/lead/train.sh` (фоном) и `Workflow({ name: "pipeline", args: { lanes: 6 } })`.

## Тесты

Первым коммитом — `lead-conveyor.test.ts` (шаг 5).

## Аналитика

Нет.

## Настройки и окружение

- `.lead/` — локальное состояние, в `.gitignore`.

## Документы

- `tasks/README.md`, `docs/09-ci-cd.md` §8.

## Критерии приёмки

- [x] Поезд, вливание по одному, статус и ожидание работы — в
      `scripts/lead/`, без абсолютных путей и секретов.
- [x] Сценарий конвейера запускается по имени из `.claude/workflows/`; при
      `extra` — два ревьюера.
- [x] Описание в `tasks/README.md` достаточно, чтобы другой тимлид поднял
      конвейер.
- [x] Тесты и гейт зелёные.

## PR

- **Заголовок:** `chore(dev): Конвейер тимлида в репозитории`
- **Метка:** `release: patch`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОНВЕЙЕР ТИМЛИДА В РЕПОЗИТОРИИ**

  Поезд мерджей и сценарий конвейера переехали из временной папки
  сессии в репозиторий (Р224): любой тимлид поднимает их одной командой.

  🛠 **Что внутри**

  • scripts/lead/ — поезд, вливание по одному, статус, ожидание работы
  • .claude/workflows/pipeline.js — конвейер на N линий; деньги и миграции проверяют два ревьюера
  ```
