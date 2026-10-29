---
id: T-0317
title: Сервер принимает запись для проверки — PUT к своему забегу, проверка формы и размера, хранение 7 дней, дольше — у проверенных
epic: E11
priority: P1
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/runs/run-proofs.repository.ts
  - backend/api/src/modules/runs/run-proofs.service.ts
  - backend/api/src/modules/runs/run-proofs-cleanup.job.ts
  - backend/api/src/modules/runs/dto/run-proof.dto.ts
  - backend/api/test/run-proofs.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/runs/runs.controller.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/runs-limits.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - docs/21-diagrams.md
  - docs/28-diagnostics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 8
---

# T-0317. Сервер принимает запись для проверки — PUT к своему забегу, проверка формы и размера, хранение 7 дней, дольше — у проверенных

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0317.json)](README.md#значки-статуса)

## Зачем

Клиент шлёт запись для проверки (T-0316) после записи забега. Серверу нужно
её принять:
- только к своему забегу;
- с проверкой формы и размера;
- без дублей.

Хранить её нужно, пока она может понадобиться повтору (T-0318, T-0319).
Хранилище не должно расти без края: обычные записи живут неделю.

## Решения

Решения владельца — WP5 (`docs/35-stage4-plan.md`).

Решения `claude-lead-1` от 25.10.2026:

- **Таблица** `run_proof`:
  - `run_id` PK и FK на `run`;
  - `proof bytea` — сжатое;
  - `size_bytes`, `received_at`, `keep_until`.
- **Маршрут** `PUT /api/v1/runs/:runId/proof`, тело — `{ proof: base64 }`:
  - забег свой — иначе 404 (не раскрываем, что забег есть);
  - декодированный размер ≤ 64 КБ, распакованный ≤ 512 КБ;
  - распакованное проходит Zod-схему `RunProof` (`run-proof.dto.ts`, поле в
    поле с T-0316);
  - `runId` записи равен `runId` в адресе;
  - хэш контента равен хэшу в строке забега.

  Ответы:
  - не прошло — 422 с причиной;
  - повтор той же записи — 200 без перезаписи;
  - другая запись к тому же забегу — 409.

  Лимит — 30 в минуту на аккаунт (`runs-limits.ts`).
- **Хранение** — `keep_until = received_at + 7 дней`. Повтор (T-0319) у
  забегов, вошедших в верх или давших редкую добычу, ставит `keep_until` на
  180 дней.

  Задание очистки раз в час удаляет просроченные пачками по 1 000.
- **Очистка аккаунта** — `run_proof` в `wipe-plan.ts` вместе с забегами.

## Как сейчас

- **Запись забега** — `runs/runs.service.ts`, `runs.controller.ts`; лимиты —
  `runs-limits.ts`.
- **Схема записи** — после T-0316 `RunProof` в `core-game` (`run-api.ts`).
  Сервер пакеты игры не импортирует — схема Zod на сервере своя, поле в поле.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `run_proof`; ER в `docs/21`; строка в `wipe-plan.ts`.
3. **`dto/run-proof.dto.ts`** — схема.
4. **Репозиторий, сервис, маршрут**, лимит.
5. **Очистка** — задание.
6. **`docs/28`** — где хранится запись для проверки и сколько.

## Чего не трогаем

- Повтор и вердикт — T-0318, T-0319.

## Тесты

Первым коммитом, `run-proofs.integration.test.ts`:
- своя запись → 200, строка с `keep_until` +7 дней;
- чужой забег → 404;
- 70 КБ → 422;
- распакованная 600 КБ → 422;
- `runId` внутри другой → 422;
- хэш контента не тот → 422;
- повтор той же → 200, без перезаписи;
- другая к тому же забегу → 409;
- очистка удаляет просроченные и не трогает 180-дневные;
- 31-й запрос в минуту → 429.

## Аналитика

Нет событий игрока; метрика `run_proofs_received_total{outcome}`.

## Настройки и окружение

Нет.

## Документы

`docs/21`, `docs/28` — по шагам.

## Критерии приёмки

- [ ] Сервер принимает запись для проверки только к своему забегу, с проверкой формы, размера и хэша контента, без дублей.
- [ ] Обычные записи живут 7 дней, у проверенных верхних — 180.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Приём записи забега для проверки`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРИЁМ ЗАПИСЕЙ ЗАБЕГОВ**

  Сервер принимает запись для проверки к своему забегу: форма, размер до 64 КБ, хэш контента. Хранит неделю, у забегов из верха и с редкой добычей — полгода.
  ```
