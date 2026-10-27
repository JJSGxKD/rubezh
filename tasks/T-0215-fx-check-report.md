---
id: T-0215
title: Отчёт проверки звука и эффектов — `pnpm fx:check`, таблица в описание PR
epic: E0
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0213, T-0214]
zones:
  - scripts/fx/check.mjs
  - scripts/fx/check-core.mjs
  - scripts/fx/frames.mjs
  - scripts/fx/sound.mjs
  - scripts/test/fx-check.test.ts
shared:
  - package.json
  - tasks/README.md
  - .claude/skills/take-task/SKILL.md
  - .claude/skills/pre-pr/SKILL.md
  - AGENTS.md
  - docs/17-testing-strategy.md
  - docs/31-audio-and-haptics.md
runner: local
executor: sonnet-5.5
effort: low
release: patch
design: null
batch: 3
---

# T-0215. Отчёт проверки звука и эффектов — `pnpm fx:check`, таблица в описание PR

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0215.json)](README.md#значки-статуса) [![T-0213](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0213.json&label=T-0213)](T-0213-fx-frames-and-metrics.md) [![T-0214](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0214.json&label=T-0214)](T-0214-fx-sound-render-and-metrics.md)

## Зачем

После T-0213 и T-0214 есть две команды — раскадровка эффектов и рендер
звуков. Исполнителю, который поменял оружие или рецепт звука, нужно не
помнить обе и их флаги, а запустить одну проверку и вставить её итог в
описание PR. После задачи `pnpm fx:check --changed` сама выбирает, что
проверять по диффу ветки, и пишет отчёт `var/fx/report.md` с готовой
таблицей для PR.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р142: запуск по
требованию, отчёт — в описание PR, в гейт CI не входит.

Решения `claude-lead-1` от 24.10.2026:

- **Команда** `pnpm fx:check [--scenes a,b] [--sounds x,y] [--changed]
  [--base …] [--out var/fx] [--browser …]`. Без флагов — всё. `--changed`
  выбирает по `git diff --name-only origin/dev...HEAD`:
  - `packages/app-shell/src/audio/recipes.ts` или `audio/synth.ts` — все
    звуки;
  - `packages/core-game/src/content/weapons.ts` или что-то в
    `packages/core-game/src/game/render/` — все сцены;
  - ничего из этого — «Звук и эффекты не менялись», код 0, отчёта нет.
- **Запуск** — те же функции, что у `fx:frames` и `fx:sound`, без второго
  браузера: `check.mjs` импортирует их обвязку.
- **Отчёт** `<out>/report.md`:
  - заголовок `## Звук и эффекты` и строка «`pnpm fx:check --changed`,
    <дата МСК>»;
  - таблица эффектов: сцена, земля, `lifeMs`, макс. доля экрана, вспышек в
    секунду, макс. объектов, `p95` кадра, пометки;
  - таблица звуков: звук, шина, пик, громкость, длина, хвост, пометки;
  - список файлов: листы кадров, спектрограммы, WAV и видео — путями
    относительно корня репозитория;
  - первыми строками — ошибки и предупреждения, если есть: «Ошибок нет» —
    тоже строкой.
- **Код выхода 1** — если у звука есть ошибка (T-0214) или у эффекта
  «частые вспышки»: вспышки чаще трёх в секунду опасны для
  светочувствительных игроков, и это не вкусовщина.
- **Правило для исполнителя** — в задаче или PR поменялся звук или эффект:
  `pnpm fx:check --changed`, таблицы из `report.md` — в описание PR
  разделом «Звук и эффекты», сами листы кадров и спектрограммы
  исполнитель смотрит до PR. Тимлид на приёмке смотрит тот же отчёт.

## Как сейчас

- После T-0213: `scripts/fx/frames.mjs`, `frames-core.mjs`, `pnpm
  fx:frames`; после T-0214: `scripts/fx/sound.mjs`, `sound-core.mjs`, `pnpm
  fx:sound`.
- `tasks/README.md`, «Как взять задачу», шаг 8 «Гейт» — снимки экранов и
  блок «Интерфейс»; про звук и эффекты ничего нет.

## Шаги по порядку

1. **`check-core.mjs`** — чистые функции: разбор аргументов, выбор по
   списку изменённых файлов, сборка Markdown отчёта из результатов.
2. **`check.mjs`** — обвязка: diff, запуск, запись отчёта, код выхода.
   Обвязки `frames.mjs` и `sound.mjs` экспортируют функцию запуска, если
   ещё не экспортируют; запуск из командной строки у них остаётся прежним.
3. **`package.json`** — `"fx:check": "node scripts/fx/check.mjs"`.
4. **Документы:**
   - `tasks/README.md`, шаг 8 «Гейт» — строка: «Поменялся звук или эффект —
     `pnpm fx:check --changed`, таблицы из `var/fx/report.md` — в описание
     PR разделом «Звук и эффекты»»;
   - скилл `take-task` (шаг «Гейт») и `AGENTS.md` — та же строка;
   - скилл `pre-pr` — раздел «Звук и эффекты» в описании PR, когда он нужен;
   - `docs/17-testing-strategy.md` («Стенд эффектов») и
     `docs/31-audio-and-haptics.md` §8 — одна строка о `fx:check`.

## Чего не трогаем

- Сами замеры и пороги — они из T-0213 и T-0214.
- Гейт CI и `pr-check`: раздел «Звук и эффекты» не проверяется
  автоматически.

## Тесты

Первым коммитом, `scripts/test/fx-check.test.ts`:

- выбор по диффу: `["packages/app-shell/src/audio/recipes.ts"]` → все звуки,
  сцен нет; `["packages/core-game/src/game/render/weapon-effects.ts"]` → все
  сцены; `["docs/x.md"]` → ничего;
- разбор: `--scenes storm,meteor --sounds spark` → две сцены и один звук;
  неизвестная сцена или звук — ошибка с id;
- отчёт: результат с ошибкой звука → первая строка «Ошибки: …», код выхода
  1; без пометок → «Ошибок нет»; вспышки 4 в секунду → код 1;
- таблица эффектов — Markdown-таблица с семью столбцами из «Решений».

## Аналитика

Нет: инструмент разработчика.

## Настройки и окружение

Нет.

## Документы

По шагу 4.

## Критерии приёмки

- [ ] `pnpm fx:check --changed` проверяет только то, что задел дифф, и
  пишет `var/fx/report.md` с готовыми таблицами.
- [ ] Ошибка звука или частые вспышки дают код 1.
- [ ] Правило «поменялся звук или эффект — отчёт в PR» записано в
  `tasks/README.md`, `take-task`, `pre-pr` и `AGENTS.md`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(dev): Отчёт проверки звука и эффектов`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОТЧЁТ ПРОВЕРКИ ЗВУКА И ЭФФЕКТОВ**

  `pnpm fx:check --changed` сама выбирает по диффу, какие звуки и эффекты проверить, и пишет отчёт с таблицами для описания PR. Ошибка звука или вспышки чаще трёх в секунду дают красный код. Поменял звук или эффект — отчёт в PR разделом «Звук и эффекты».
  ```
