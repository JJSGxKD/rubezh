---
id: T-0462
title: Второй ключ на крупные операции финансов, уведомление и картинка чека
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: S
depends_on: [T-0461]
zones:
  - backend/api/src/modules/ledger/operations/approval.ts
  - backend/api/src/modules/ledger/operations/operations-notify.ts
  - backend/api/test/ledger-approval.test.ts
  - backend/api/test/ledger-approval.integration.test.ts
shared:
  - backend/api/src/modules/ledger/operations/operations.service.ts
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/test/admin-ledger.http.test.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/media/image-rules.ts
  - backend/api/src/modules/media/**
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
  - docs/21-diagrams.md
  - docs/37-accounting.md
  - backend/api/src/modules/admin/admin-media.controller.ts
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/modules/ledger/operations/operation-errors.ts
  - backend/api/src/modules/ledger/operations/operation-input.ts
  - backend/api/src/modules/ledger/operations/operation-view.ts
  - backend/api/src/modules/ledger/operations/operations.repository.ts
  - backend/api/test/ledger-operations.integration.test.ts
  - backend/api/test/ledger-operations.test.ts
  - backend/api/test/route-permissions.test.ts
  - backend/api/test/ledger-templates.integration.test.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 4
---

# T-0462. Второй ключ на крупные операции финансов, уведомление и картинка чека

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0462.json)](../README.md#значки-статуса) [![T-0461](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0461.json&label=T-0461)](T-0461-ledger-manual-operations.md)

## Зачем

Ручные операции (T-0461) проводятся сразу. По решению владельца (Р220)
крупная операция, которую внёс не владелец, сначала ждёт его подтверждения,
а владелец узнаёт об этом в чате команды. К операции прикладывается снимок
чека — чтобы через полгода было видно, откуда цифра.

## Решения

- `docs/35-stage4-plan.md`, **Р220**; `docs/29-admin-panel.md` §4,
  «Правило двух ключей».
- **Порог** — настройка «Подтверждение владельцем от, $»
  (`finance.approve-threshold-usd`, 200, 0…100 000) в группе «Платежи» —
  или новой «Бухгалтерия», если она заведена к этому времени.
  Оценка — `amount_usd` операции (T-0461). Нет курса — оценки нет —
  операция **ждёт подтверждения** (неизвестное — не мелочь).
- Новое право **`finance.operation.approve`** — только владелец (через
  `PERMISSIONS`). У кого оно есть — его операции проводятся сразу.
- Исправление (`reversal`) от финансов ждёт подтверждения **всегда**:
  сторно меняет уже проведённое.
- Поток уведомлений — `notify.chat.finance` «Бухгалтерия» (пусто — общий
  чат; память команды: новый вид уведомлений — свой поток в панели).
- **Картинка чека** — новый профиль хранилища картинок `finance_receipt`:
  не квадратная, сторона 300…1 600, право загрузки — `finance.entry.create`,
  **показ — только с `ledger.view`** (у других профилей показ шире — проверить
  и закрыть именно для этого профиля). У операции — поле `receipt_image`.

## Как сейчас

- `OperationsService.submit` (T-0461) проводит черновик сразу.
- Профили картинок — `modules/media/image-rules.ts`, `IMAGE_PROFILES`
  (`task`, `home_slide`: `square`, `minSide`, `maxSide`, `permission`);
  загрузка и показ — `admin/admin-media.controller.ts`.
- Потоки чата команды — `notify.chat.*` в `setting-catalog.ts`
  (пример — `chat("notify.chat.payments", …)`), отправка — модуль
  `admin-notify`.

## Шаги по порядку

1. **Правило** `operations/approval.ts`, чистая функция
   `needsApproval({ kind, amountUsd, actorCanApprove, thresholdUsd }): boolean`:
   у кого есть право подтверждать — `false`; `reversal` — `true`;
   `amountUsd` нет — `true`; иначе `amountUsd ≥ thresholdUsd`.
2. **`submit`**: нужен второй ключ → статус `pending`, уведомление; иначе —
   проводка, как раньше. Новые методы: `approve(owner, id, note?)` →
   проводка, `decided_by/at`; `reject(owner, id, note)` (причина
   обязательна) → `rejected`. Подтвердить свою же операцию нельзя — у
   владельца своих `pending` не бывает. Аудит:
   `ledger.operation.approve|reject`.
3. **Уведомление** `operations-notify.ts`: в поток `notify.chat.finance` —
   «💼 Операция на подтверждении: <вид> <сумма> <валюта> (≈ <N> $) —
   <имя>: «<причина>»» и ссылка на операцию в панели; после решения — ответ
   в той же ветке «подтверждено» или «отклонено: <причина>». Отправка не
   блокирует ответ API (очередь, как у других уведомлений).
4. **Права и настройки**: `finance.operation.approve` в `PERMISSIONS`;
   ключ порога и поток чата — в каталоге настроек; строки в
   `docs/30-configuration-map.md`.
5. **Картинка чека**: профиль `finance_receipt` в `IMAGE_PROFILES`; показ
   картинки этого профиля — с проверкой `ledger.view`; поле
   `receipt_image char(64) null` у `ledger_operation` (миграция), в
   `create`/`update` — id загруженной картинки (проверка, что она есть и
   профиля `finance_receipt`).
6. **Маршруты**: `POST /operations/:id/approve`, `POST /operations/:id/reject`
   — право `finance.operation.approve`.
7. **Документы**: `docs/29-admin-panel.md` §4 — в «Правило двух ключей»
   строка «операция финансов дороже порога и любое исправление».

## Чего не трогаем

- Сборщики проводок и виды операций — T-0461.
- Экран — T-0464.

## Сценарий и интерфейс

- Финансы проводят расход 250 $ → «ждёт подтверждения», в чате —
  карточка; владелец подтверждает в панели → проводка, в чате «подтверждено».
- Финансы проводят расход 40 $ → проводится сразу.

## Тесты

Первым коммитом:

- `backend/api/test/ledger-approval.test.ts`: `needsApproval` — владелец
  (всегда сразу), финансы ниже и выше порога, ровно порог, без оценки,
  исправление.
- `backend/api/test/ledger-approval.integration.test.ts` (Postgres):
  `pending` не создаёт проводки; `approve` создаёт ровно одну (два
  одновременных `approve` — одна); `reject` — без проводки, с причиной;
  повторное решение — 409.
- `backend/api/test/admin-ledger.http.test.ts`: финансы на `approve` — 403;
  картинка `finance_receipt` маркетологу — 403, финансам — 200.

## Аналитика

Нет событий; метрика очереди уведомлений — существующая.

## Настройки и окружение

- `finance.approve-threshold-usd`, `notify.chat.finance` — каталог
  настроек, `docs/30-configuration-map.md`.

## Документы

- `docs/29-admin-panel.md` §4, `docs/30-configuration-map.md`.

## Критерии приёмки

- [x] Крупная операция финансов и любое исправление ждут владельца и до
      подтверждения ничего не проводят; владелец проводит сразу.
- [x] Владелец получает карточку в потоке «Бухгалтерия» и видит решение в
      той же ветке.
- [x] Картинка чека загружается и показывается только тем, кто видит учёт.
- [x] Тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(finance): Второй ключ и чек к операции`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ КЛЮЧ И ЧЕК К ОПЕРАЦИИ**

  Крупная операция финансов (от 200 $) и любое исправление теперь ждут
  подтверждения владельца (Р220); к операции прикладывается снимок чека.

  🛠 **Что внутри**

  • порог — «Подтверждение владельцем от, $» в настройках
  • карточка операции — в потоке чата «Бухгалтерия», решение — ответом в ветке
  • снимок чека виден только тем, кто видит учёт

  ❓ **Нужно от команды**

  • @владелец — при желании назначить отдельную тему чата для потока «Бухгалтерия» в «Настройках»
  ```
