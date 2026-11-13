---
id: T-0473
title: Хуки-ограждения Claude Code — запреты до выполнения и быстрые проверки после правки
epic: E0
priority: P1
status: in-progress
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - .claude/settings.json
  - scripts/hooks/**
  - scripts/test/claude-hooks.test.ts
shared:
  - tasks/README.md
  - CLAUDE.md
  - AGENTS.md
runner: local
executor: sonnet-5.5
effort: high
release: patch
merge: lead
design: null
batch: 5
---

# T-0473. Хуки-ограждения Claude Code — запреты до выполнения и быстрые проверки после правки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0473.json)](README.md#значки-статуса)

## Зачем

Правила команды — «только pnpm», «без `git push --force`», «рабочие копии не
удалять `Remove-Item -Recurse`», «`.env` не трогать», «тесты — на Redis 13 и
`rubezh_test`» — держатся на тексте `CLAUDE.md` и памяти агента. Нарушение
всплывает поздно: на ревью, в CI или поломкой машины. Хуки Claude Code
делают правило автоматикой (Р224, A): запрещённое не выполняется, а
типичная ошибка в изменённом файле видна сразу, а не через 15 минут CI.

## Решения

- `docs/35-stage4-plan.md`, **Р224** (A).
- Хуки — в **`.claude/settings.json` репозитория** (не в личных
  настройках): действуют на каждую сессию и каждого агента в этом
  репозитории. `.claude/launch.json` не трогать.
- Скрипты хуков — **Node.js** (`scripts/hooks/*.mjs`): владелец и агенты на
  Windows, CI на Linux; bash-однострочники и `tmux` не годятся.
- Формат — как в документации Claude Code: событие `PreToolUse`/`PostToolUse`,
  `matcher` — имя инструмента (`Bash`, `PowerShell`, `Edit|Write`), скрипт
  читает JSON из stdin; **код выхода 2 — запрет** с причиной в stderr (её
  видит агент). Сверить формат с актуальной документацией перед кодом.
- Ошибка самого скрипта хука **не блокирует** работу (выход 0 и строка в
  stderr): сломанный хук не должен остановить команду.

## Как сейчас

- `.claude/settings.json` нет; есть `.claude/launch.json` и `.claude/skills/`.
- Проверки по исходникам — `scripts/test/layer-boundaries.test.ts`,
  `packages/core-game/test/sim-purity.test.ts` (их правила — образец для
  быстрой проверки одного файла).

## Шаги по порядку

1. `scripts/hooks/guard-command.mjs` — `PreToolUse` для `Bash` и
   `PowerShell`: запрет с понятной причиной и подсказкой «как правильно»:
   - `npm install`/`npm i`/`npm ci` → «В репозитории только pnpm: `pnpm install`»;
   - `git push` с `--force`/`-f`/`--force-with-lease` → «Push без --force»;
   - `Remove-Item … -Recurse` → «Рабочие копии — `git worktree remove --force`
     и `cmd /c rmdir /s /q`: Remove-Item идёт по junction'ам pnpm»;
   - запись в `.env` (перенаправление `> .env`, `Set-Content`/`Out-File`
     в `.env`, `sed -i … .env`) → «`.env` правит только владелец»;
   - тестовые запуски с `redis://…/14` или базой `bullet_heaven` →
     «Тесты — на Redis 13 и `rubezh_test` (`test-env.sh`)»;
   - `npx <пакет>` не из списка разрешённых (`prisma`, `vitest`, `tsc`,
     `eslint`, `playwright`) → «Непроверенный npx — сначала спросить».
2. `scripts/hooks/guard-write.mjs` — `PreToolUse` для `Edit|Write`: запрет
   правки `.env`, `.env.*` (кроме `.env.example`) и `.claude/launch.json`.
3. `scripts/hooks/check-edit.mjs` — `PostToolUse` для `Edit|Write` на
   `*.ts`/`*.tsx`: eslint одного файла (через `pnpm exec eslint`, таймаут
   20 с), для файлов `game/sim/*`, `patterns/*`, `weapons/*`,
   `progression/*`, `run/*`, `balance/*` — те же запреты, что
   `sim-purity.test.ts` (`Math.random`, `Date.now`, `Math.sin` и т. п.),
   для любого файла — нарушения границ слоёв по правилам
   `layer-boundaries.test.ts` (вынести общий список правил в модуль, который
   читают и тест, и хук). Находки — в stderr, **без блокировки** (правка уже
   сделана; агент видит и чинит).
4. `.claude/settings.json` — подключение трёх хуков.
5. Документы: `tasks/README.md`, «Окружение исполнителя» — абзац «Хуки:
   что блокируется и почему»; `CLAUDE.md` и `AGENTS.md` — строка, что
   правила из «Окружение команды» проверяются хуками.

## Чего не трогаем

- `.claude/launch.json`, личные настройки владельца.
- Сами правила `layer-boundaries` и `sim-purity` — только переиспользовать.

## Сценарий и интерфейс

- Агент пишет `npm install lodash` → команда не выполняется, агент видит
  «В репозитории только pnpm…».
- Агент вставляет `Math.random()` в `game/sim/foo.ts` → сразу после правки
  в выводе: «sim-purity: Math.random в game/sim/foo.ts:12 — рандом только
  через инжектируемый генератор».

## Тесты

Первым коммитом `scripts/test/claude-hooks.test.ts`: каждый скрипт
запускается с JSON на stdin — запрещённые команды дают код 2 и причину,
разрешённые (`pnpm install`, `git push`, `git worktree remove --force`,
`npx prisma migrate diff`) — 0; правка `.env.example` разрешена, `.env` —
нет; проверка правки находит `Math.random` в `game/sim` и не трогает его в
`game/render`; сломанный JSON на входе — код 0.

## Аналитика

Нет.

## Настройки и окружение

- `.claude/settings.json` — новый файл (хуки).

## Документы

- `tasks/README.md`, `CLAUDE.md`, `AGENTS.md` (шаг 5).

## Критерии приёмки

- [ ] Запрещённые команды и правки не выполняются, причина понятна агенту.
- [ ] После правки TS-файла агент сразу видит ошибки eslint, чистоты
      симуляции и границ слоёв.
- [ ] Хуки работают в PowerShell и Git Bash на Windows; сломанный хук не
      блокирует работу.
- [ ] Тесты и гейт зелёные.

## PR

- **Заголовок:** `chore(dev): Хуки-ограждения Claude Code`
- **Метка:** `release: patch`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ХУКИ-ОГРАЖДЕНИЯ CLAUDE CODE**

  Правила команды стали автоматикой (Р224): запрещённое — npm install,
  push --force, Remove-Item -Recurse, правка .env, тесты на Redis 14 —
  не выполняется, а ошибки чистоты симуляции и границ слоёв видны сразу
  после правки, а не в CI.

  🛠 **Что внутри**

  • .claude/settings.json — действует на каждую сессию и каждого агента в репозитории
  • причина запрета — с подсказкой, как правильно
  ```
