---
id: T-0319
title: Перепроверка забегов — кому повтор обязателен, выборка остальных, постановка в sim-worker, исход в вердикт забега и в разбор
epic: E11
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0317, T-0318, T-0294, T-0295]
zones:
  - backend/api/src/modules/runs/run-replay.service.ts
  - backend/api/src/modules/runs/run-replay-rules.ts
  - backend/api/src/modules/runs/run-replay.job.ts
  - backend/api/test/run-replay-rules.test.ts
  - backend/api/test/run-replay.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/runs/run-proofs.service.ts
  - backend/api/src/modules/admin/admin-review.controller.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - apps/admin/src/screens/review/**
  - apps/admin/src/api/review.ts
  - docs/22-analytics-and-metrics.md
  - docs/28-diagnostics.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 8
---

# T-0319. Перепроверка забегов — кому повтор обязателен, выборка остальных, постановка в sim-worker, исход в вердикт забега и в разбор

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0319.json)](README.md#значки-статуса) [![T-0317](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0317.json&label=T-0317)](T-0317-run-proof-server.md) [![T-0318](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0318.json&label=T-0318)](T-0318-sim-worker-replay.md) [![T-0294](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0294.json&label=T-0294)](T-0294-rating-boards-by-points.md) [![T-0295](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0295.json&label=T-0295)](T-0295-rating-divisions-and-style.md)

## Зачем

Запись для проверки приходит (T-0316, T-0317), воркер умеет повторять
(T-0318). После задачи сервер сам решает, какой забег повторить, и ставит
его в очередь. Исход становится частью вердикта забега:
- совпал — забег проверен;
- разошёлся — подозрение, забег уходит из рейтинга в разбор, и модератор
  видит тик расхождения.

Что проверенность даёт и чего лишает — T-0320.

## Решения

Решения владельца — `docs/35-stage4-plan.md` WP5:
- повтор обязателен для забегов, от которых что-то зависит:
  - редкая добыча;
  - верх любого рейтинга;
  - повышение в верхних дивизионах;
  - награды выше порога;
- остальные — выборкой, для наблюдения за детерминизмом;
- расхождение на первых неделях — `suspicious`, а не `rejected`: сначала
  меряем, насколько V8 сервера расходится с JavaScriptCore iPhone.

Решения `claude-lead-1` от 25.10.2026:

- **Обязателен повтор** (`run-replay-rules.ts`, чистая функция от забега и
  его последствий):
  - место ≤ 100 в общей или сезонной доске (T-0294);
  - дивизион сезона «рубин» или «золото» (T-0295);
  - добыча забега редкости «эпическая» и выше;
  - победа над Стражем рубежа (награда T-0121);
  - пролог — нет: его награда — разовая и малая.
- **Выборка** — остальные рейтинговые забеги с вероятностью
  `replay.sample-rate`, ключ панели, умолчание 0,05. Бросок — от хэша
  `runId`: решение воспроизводимо.
- **Постановка** — когда есть и забег, и запись (T-0317): задание `replay`
  в `sim-worker`.
  - Обязательные — с высоким приоритетом.
  - Записи нет 72 часа — исход `no_proof`.
- **Хранение исхода** — поля `run`:
  - `replay_verdict` — `pending`, `match`, `mismatch`, `content_mismatch`,
    `not_replayable`, `broken`, `timeout`, `no_proof`, `null` — не нужен;
  - `replay_diverged_tick`;
  - `replayed_at`.
- **Исход в вердикт:**
  - `match` — вердикт не меняется, `keep_until` записи — 180 дней (T-0317);
  - `mismatch` — причина `replay_mismatch`, вердикт по ключу
    `replay.mismatch-verdict`: `suspicious` (умолчание) или `rejected`.
    Подозрительный уходит из рейтинга, как сейчас (`ranked = false`, доски
    пересчитываются);
  - `content_mismatch`, `broken`, `timeout` — вердикт не меняется, в лог; это
    наша сторона, а не игрок;
  - `not_replayable`, `no_proof` — вердикт не меняется. Последствия для
    наград и верха — T-0320.
- **Разбор** — очередь разбора (`admin-review.controller.ts`, раздел панели) показывает:
  - исход повтора и тик расхождения;
  - таблицу «заявлено / повтор»;
  - кнопку «Повторить снова» (ставит задание ещё раз, в аудите).
- **Наблюдение** — событие `run_replayed { run_id, verdict, diverged_tick, duration_ms, client_os }`
  тем же писателем событий, что `run_scored` (T-0293).
  - Метрика `replay_outcome_total{verdict,client_os}`: `client_os` — `ios`,
    `android`, `desktop`, `web`, низкая кардинальность.
  - По ней видно расхождение движков.

## Как сейчас

- **Вердикт забега** — `runs/run-verdict.ts` (`ok`, `suspicious`, `rejected`, причины).
- **Рейтинг** — `ranked`, после T-0294 — доски по очкам; после T-0295 — дивизионы.
- **Очередь разбора** — `admin/admin-review.controller.ts` (`GET runs/review`).
- **После T-0317** — `run_proof`; **после T-0318** — очередь `replay` и формат исхода.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — поля `run`; ключи `replay.sample-rate`, `replay.mismatch-verdict`.
3. **`run-replay-rules.ts`** — кому обязателен, выборка.
4. **`run-replay.service.ts`, `.job.ts`** — постановка, чтение исхода, вердикт, `no_proof` через 72 часа.
5. **Разбор** — исход в очереди и «Повторить снова».
6. **Событие и метрика** — сначала словарь `docs/22` и Zod.
7. **Документы:**
   - `docs/28` — перепроверка на сервере;
   - `docs/30` — ключи;
   - `docs/35` WP5 — «Как сделано».

## Чего не трогаем

- Последствия для добычи, наград и сезона — T-0320.

## Тесты

Первым коммитом.

- `run-replay-rules.test.ts`:
  - 87-е место общей доски → обязателен;
  - эпическая добыча → обязателен;
  - обычный забег → выборка, решение одинаково на одном `runId`;
  - пролог → не нужен.
- `run-replay.integration.test.ts`:
  - запись пришла → задание поставлено;
  - `match` → вердикт прежний, хранение 180 дней;
  - `mismatch` → `suspicious`, из рейтинга ушёл;
  - ключ `rejected` → `rejected`;
  - `timeout` → вердикт прежний;
  - записи нет 72 часа → `no_proof`;
  - «Повторить снова» — новое задание и строка аудита.

## Аналитика

По шагу 6.

## Настройки и окружение

Ключи `replay.sample-rate`, `replay.mismatch-verdict`.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Забеги, от которых что-то зависит, повторяются обязательно; остальные — выборкой.
- [ ] Расхождение — подозрение (по ключу — отказ), забег уходит из рейтинга в разбор с тиком расхождения.
- [ ] Исходы видны по площадкам метрикой и событием.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Перепроверка забегов повтором`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПЕРЕПРОВЕРКА ЗАБЕГОВ**

  Сервер повторяет забеги, от которых что-то зависит (верх рейтинга, золото и рубин, эпическая добыча, победа над Стражем), и 5 % остальных. Разошёлся — забег уходит в разбор с тиком расхождения. Метрика показывает расхождения по площадкам.
  ```
