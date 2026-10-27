---
id: T-0318
title: sim-worker — очередь повтора забега: та же симуляция по записи, снимку контента и снаряжению, исход и тик расхождения
epic: E11
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0302, T-0316]
zones:
  - apps/sim-worker/src/replay-job.ts
  - apps/sim-worker/test/replay-job.test.ts
shared:
  - apps/sim-worker/src/main.ts
  - apps/sim-worker/package.json
  - packages/core-game/src/game/diagnostics/replay.ts
  - packages/core-game/src/index.ts
  - docs/28-diagnostics.md
  - docs/21-diagrams.md
runner: local
executor: sonnet-5.5
effort: extra
release: patch
design: null
batch: 8
---

# T-0318. sim-worker — очередь повтора забега: та же симуляция по записи, снимку контента и снаряжению, исход и тик расхождения

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0318.json)](README.md#значки-статуса) [![T-0302](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0302.json&label=T-0302)](T-0302-sim-worker.md) [![T-0316](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0316.json&label=T-0316)](T-0316-run-proof-client.md)

## Зачем

`sim-worker` (T-0302) проверяет черновики контента. По Р15 его вторая работа —
перепроверка забегов (WP5). После задачи у воркера есть очередь `replay`:
1. берёт запись для проверки (T-0316);
2. берёт снимок контента по хэшу и снаряжение;
3. прогоняет ту же симуляцию, что `pnpm replay`;
4. отдаёт исход — совпал или разошёлся и на каком тике.

Что делать с исходом, решает сервер (T-0319).

## Решения

Решения владельца:
- Р15 — повтор забегов в `sim-worker`;
- WP5 — повтор на сервере, расхождение на первых неделях — подозрение, а не отказ.

Решения `claude-lead-1` от 25.10.2026:

- **Задание** `replay`: `{ runId, proof, contentSnapshot | null, claimed }`, где:
  - `proof` — распакованная запись;
  - `contentSnapshot` — снимок по хэшу записи (T-0306, T-0307):
    - `null` — хэш совпадает со встроенным контентом воркера;
    - нет ни того ни другого — `content_mismatch`, без повтора;
  - `claimed` — итог, который заявил клиент: время, уровень, убийства, контрольная сумма.
- **Повтор** — `replayRecording` из `game/diagnostics/replay.ts` на записи
  для проверки, тем же построением мира, что сцена. Сверяются:
  - контрольные суммы `checkpoints` по пути — первое расхождение даёт тик;
  - итог — с `claimed`.
- **Исход** — `{ runId, verdict, divergedTick, replayed: { ticks, survivalSec, level, enemiesKilled, checksum }, durationMs }`.
  `verdict` — как у `pnpm replay`:
  - `match`;
  - `mismatch`;
  - `content_mismatch`;
  - `not_replayable`;
  - `broken`.
- **Пределы:**
  - один повтор — до 60 с, дольше — `timeout`;
  - конкурентность — 1 на процесс, общая с `content-check`;
  - приоритет у `content-check` (человек ждёт в панели).
- **Метрики:**
  - `sim_jobs_total{queue="replay",outcome}`;
  - `sim_job_seconds{queue="replay"}`.

## Как сейчас

- **Повтор** — `core-game/src/game/diagnostics/replay.ts`, скрипт `scripts/replay.mjs`
  (`docs/28` §3.4).
- **После T-0302** — `sim-worker`, очередь `content-check`, метрики.
- **После T-0316** — `RunProof`.

## Шаги по порядку

1. **Тесты первым коммитом** — `replay-job.test.ts`:
   - честная запись → `match`;
   - подменённый выбор → `mismatch` с тиком;
   - чужой хэш без снимка → `content_mismatch`;
   - `claimed` с завышенным временем при совпавшем повторе → `mismatch`
     (итог разошёлся с заявленным);
   - зацикленная запись → `timeout`.
2. **`replay-job.ts`** — задание и исход; регистрация в `main.ts` с
   приоритетом.
3. **Документы:**
   - `docs/28` §3.4 — повтор на сервере;
   - `docs/21` — очередь на схеме.

## Чего не трогаем

- Кому повтор и что делать с исходом — T-0319.

## Тесты

Первым коммитом — шаг 1.

## Аналитика

Метрики по «Решениям»; событие `run_replayed` пишет сервер (T-0319).

## Настройки и окружение

Нет.

## Документы

По шагу 3.

## Критерии приёмки

- [ ] `sim-worker` повторяет забег по записи для проверки и снимку контента, отдаёт исход и тик расхождения.
- [ ] Заявленный итог сверяется с повтором; пределы времени и приоритет очередей.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(infra): Повтор забега в sim-worker`
- **Метка:** `release: patch`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОВТОР ЗАБЕГА НА СЕРВЕРЕ**

  sim-worker научился повторять забег по записи игрока: та же симуляция, тот же контент и снаряжение. Исход — совпал или разошёлся и на каком тике, и сходится ли итог с заявленным.
  ```
