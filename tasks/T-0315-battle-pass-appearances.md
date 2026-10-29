---
id: T-0315
title: Батл-пасс — облики в наградах: окрасы на 10-й и 20-й бесплатной ленты, окрасы и облик сезона в VIP-ленте
epic: E16
priority: P3
status: draft
owner:
author: claude-lead-1
size: S
depends_on: [T-0313, T-0245]
zones:
  - backend/api/test/battle-pass-appearances.integration.test.ts
shared:
  - backend/api/src/modules/battle-pass/**
  - backend/api/src/modules/admin/admin-pass.controller.ts
  - backend/api/src/modules/appearance/**
  - apps/admin/src/screens/pass/**
  - packages/app-shell/src/screens/meta/pass.tsx
  - packages/app-shell/src/i18n/ru.json
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/backlog.md
batch: 8
---

# T-0315. Батл-пасс — облики в наградах: окрасы на 10-й и 20-й бесплатной ленты, окрасы и облик сезона в VIP-ленте

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0315.json)](README.md#значки-статуса) [![T-0313](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0313.json&label=T-0313)](T-0313-battle-pass-ribbons-panel.md) [![T-0245](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0245.json&label=T-0245)](T-0245-keeper-set-server.md)

**Черновик.** Ждёт:
- таблицу владения обликами `appearance_grant` (T-0245);
- окрасы месяца от дизайнера (пункт 17 очереди, `design/art/backlog.md`).

Владелец переводит задачу в `ready`, когда первые окрасы нарисованы.

## Зачем

По решению владельца пасс держит обликами:
- бесплатная лента даёт окрас на 10-й и 20-й ступенях;
- VIP-лента — свои окрасы и облик сезона на 30-й.

После задачи награда ступени может быть обликом. Он выдаётся строкой
владения, виден на ленте портретом и надевается в «Облике».

## Решения

Решения владельца — 25.10.2026, опрос: окрасы на 10/20 в бесплатной, облик
сезона в VIP.

Решения `claude-lead-1` от 25.10.2026:

- **Награда** `appearance: <id>` в схеме ступени (T-0311):
  - id — из каталога обликов (T-0237);
  - выдача — `appearance_grant (source: "pass")` с `ON CONFLICT DO NOTHING`.

  Уже есть облик — вместо него 30 самоцветов (ключ `pass.duplicate-gems`),
  а не пустая награда.
- **Панель** (T-0313) — у ячейки ступени вид «Облик» с выбором из каталога
  и портретом.
- **Экран** (T-0314) — у ступени с обликом портрет вместо значка, тап —
  крупно.

## Как сейчас

- После T-0245 — `appearance_grant`; после T-0237 — каталог обликов; после
  T-0311–T-0314 — пасс, панель, экран.

## Шаги по порядку

1. **Тесты первым коммитом** — `battle-pass-appearances.integration.test.ts`:
   - забор ступени с обликом → строка владения, облик в «Облике»;
   - повтор → без дубля;
   - облик уже был → самоцветы;
   - закрытие месяца выдаёт облик так же.
2. **Схема награды**, выдача, ключ `pass.duplicate-gems`.
3. **Панель и экран** — вид «Облик».
4. **`docs/29`**.

## Чего не трогаем

- Ленты по умолчанию — без обликов.

## Тесты

Первым коммитом — шаг 1.

## Аналитика

`pass_reward_claimed` уже несёт ленту и ступень.

## Настройки и окружение

Ключ `pass.duplicate-gems`.

## Документы

По шагу 4.

## Критерии приёмки

- [ ] Облик — награда ступени: выдаётся владением, повтор и уже имеющийся — без дубля.
- [ ] Панель выбирает облик из каталога, экран показывает портрет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Облики в наградах пасса`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: в батл-пассе — окрасы и облик сезона`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЛИКИ В ПАССЕ**

  Награда ступени пасса может быть обликом: окрасы на 10-й и 20-й бесплатной ленты, окрасы и облик сезона в VIP. Уже имеющийся облик заменяется самоцветами.
  ```
