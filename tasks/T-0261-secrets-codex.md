---
id: T-0261
title: Кодекс тайников — найденные за всё время на сервере, раздел гайдбука с преданиями, достижение и знак «Следопыт»
epic: E16
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0260, T-0235]
zones:
  - backend/api/src/modules/secrets-codex/**
  - backend/api/test/secrets-codex.integration.test.ts
  - packages/app-shell/src/screens/guide/secrets.tsx
  - packages/app-shell/test/guidebook-secrets.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/tasks/task-rules.ts
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/src/i18n/ru.json
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - docs/21-diagrams.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0261. Кодекс тайников — найденные за всё время на сервере, раздел гайдбука с преданиями, достижение и знак «Следопыт»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0261.json)](README.md#значки-статуса) [![T-0260](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0260.json&label=T-0260)](T-0260-secrets-look-and-blessing.md) [![T-0235](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json&label=T-0235)](T-0235-emblems-server.md)

## Зачем

Тайник, найденный в забеге, забывается вместе с забегом. После задачи
сервер помнит, какие виды тайников игрок находил за всё время. В гайдбуке
есть раздел «Тайники»: «4 из 6 найдено», у каждого — короткое предание.
Нашёл все шесть — достижение «Следопыт» со знаком у имени.

## Решения

Решения владельца — Р153 (кодекс тайников в гайдбуке) и
`design/art/meta-v2.md` §5.3 (предания, знак «Следопыт»).

Решения `claude-lead-1` от 24.10.2026:

- **Хранение:** таблица `secret_found (account_id, kind, first_at)`, ключ
  `(account_id, kind)`. Пишется при записи забега из `secrets.found` итога
  (T-0258), `ON CONFLICT DO NOTHING`. Только забеги, которые считаются по
  правилам наград (`countsForTasks`).
- **Достижение** `ach_secrets_all` «Следопыт»:
  - вид цели `secrets_kinds` (`max` по числу видов), цель 6;
  - категория `collection`, престиж 40;
  - знак у имени редкости `epic` (T-0235).

  Окрас за «Следопыта» — когда дизайнер его нарисует; здесь его нет.
- **`GET /api/v1/codex/secrets`** → `{ data: { found: SecretKind[] } }`.
- **Раздел гайдбука** `screens/guide/secrets.tsx`:
  - шесть карточек: найденный — облик тайника (фигура T-0260), имя,
    предание и что делает; ненайденный — силуэт и «Ещё не найден»;
  - сверху «Найдено: N из 6».
- **Предания** — короткие, по две строки, ключи `secret.<kind>.lore` в
  `ru.json` (тексты ниже, дословно).

## Как сейчас

- После T-0258: `secrets.found` в итоге забега. После T-0235 — `emblem_tier` у
  достижений. Гайдбук — `screens/guide/GuideScreen.tsx` (вкладки), данные — `guide-data.ts`.
- Запись забега и правило наград — `runs/runs.service.ts`, `countsForTasks`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `secret_found`; строка достижения `ach_secrets_all`; ER в
   `docs/21`.
3. **Модуль `secrets-codex`** — запись из итога, маршрут, обновление
   прогресса `secrets_kinds` (`applyState` T-0106).
4. **Вид цели** `secrets_kinds` в `task-rules.ts` (`STATE_KINDS`).
5. **Гайдбук** — раздел по «Решениям».
6. **Очистка** — `secret_found` в `wipe-plan.ts` и `wipe-runner.ts`.
7. **Тексты `ru.json`** (предания), дословно:
   - `secret.shrine.lore`: «Здесь молились тем, кто держал рубеж до нас. Постой — и они ответят.»;
   - `secret.hoard.lore`: «Кто-то закопал добро и не вернулся. Теперь оно твоё — если успеешь выкопать.»;
   - `secret.tree.lore`: «Старое дерево помнит первых хранителей. В его тени раны затягиваются.»;
   - `secret.rift.lore`: «Здесь Навь подошла слишком близко. Шагни — и она шагнёт навстречу.»;
   - `secret.stone.lore`: «Камень ставили дозорные: коснись — и увидишь, что они отметили.»;
   - `secret.wisp.lore`: «Огонёк знает дорогу. Иди за ним — он не обманет.»;
   - раздел: `"guidebook.secrets": "Тайники"`, `"guidebook.secrets.found": "Найдено: {count} из {total}"`, `"guidebook.secrets.unknown": "Ещё не найден"`.

## Чего не трогаем

- Движок и облик — T-0258–T-0260.
- Окрас за «Следопыта» — дизайнер.

## Тесты

Первым коммитом.

- `secrets-codex.integration.test.ts`:
  - забег с найденными капищем и кладом → два вида в кодексе; повтор — без дублей;
  - забег, не прошедший правило наград, — не пишется;
  - все шесть → `ach_secrets_all` выполнено, знак держится.
- `guidebook-secrets.test.ts` — по разделу `guide/secrets.tsx`: «Найдено: 2 из 6», ненайденный — силуэт без
  предания.

## Аналитика

Нет новых: находки — `secret_found` (T-0260).

## Настройки и окружение

Нет.

## Документы

`docs/21` — ER.

## Критерии приёмки

- [ ] Сервер помнит найденные виды тайников; гайдбук показывает кодекс с преданиями.
- [ ] Все шесть — достижение и знак «Следопыт».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Кодекс тайников и «Следопыт»`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: кодекс тайников в гайдбуке и знак «Следопыт» за все шесть`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОДЕКС ТАЙНИКОВ**

  Сервер помнит, какие тайники игрок находил; в гайдбуке — раздел «Тайники» с преданиями и «Найдено N из 6». Все шесть — достижение «Следопыт» со знаком у имени.
  ```
