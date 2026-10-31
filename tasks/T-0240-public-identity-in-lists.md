---
id: T-0240
title: Знак у имени в строках рейтинга, сезона и друзей — порт PublicIdentity
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0235, T-0161, T-0111]
zones:
  - backend/api/src/common/public-identity.ts
  - backend/api/test/public-identity.test.ts
  - backend/api/test/public-identity.integration.test.ts
shared:
  - backend/api/src/modules/achievements/achievements.module.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/seasons/seasons-view.service.ts
  - backend/api/src/modules/seasons/seasons.module.ts
  - backend/api/src/modules/seasons/dto/seasons.dto.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/friends/friends.module.ts
  - packages/shared-types/src/index.ts
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0240. Знак у имени в строках рейтинга, сезона и друзей — порт PublicIdentity

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0240.json)](README.md#значки-статуса) [![T-0235](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json&label=T-0235)](T-0235-emblems-server.md) [![T-0161](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0161.json&label=T-0161)](T-0161-supporter-badge-api.md) [![T-0111](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0111.json&label=T-0111)](T-0111-weekly-season-screen.md)

## Зачем

После T-0235 сервер знает, какой знак игрок носит, но строки рейтинга,
сезона и друзей его не несут: там по-прежнему только `tester` и
`supporter`. После задачи в каждой такой строке — выбранный знак игрока или
знак по умолчанию. Строку кладут одним запросом на весь список через общий
порт, и этот же порт потом понесёт облик (T-0237).

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р149: в списках — один
выбранный знак.

Решения `claude-lead-1` от 24.10.2026:

- **Один порт `PublicIdentity`** (`common/public-identity.ts`): интерфейс
  `of(accountIds): Promise<Map<accountId, PublicMark>>` и класс с
  `provide()`. Образец — `RunPrestige` (T-0107, `runs/run-prestige.ts`) и
  `RunLoadouts` (`runs/run-loadouts.ts`).
  - Источник регистрирует `achievements.module.ts` (`EmblemsService.of`,
    T-0235).
  - Рейтинг, сезон и друзья только читают и о достижениях не знают.
  - Один порт вместо трёх: облик (T-0237) добавится в тот же `PublicMark`.
- **`PublicMark = { emblem?: PublicEmblem }`**, где `PublicEmblem = { id,
  title, tier, category: "status" | "season" | "merit", season?: number }` —
  в `shared-types`. Строки `LeaderboardEntry`, строки таблицы сезона и
  строки друзей получают необязательное `emblem`.
- **Сбой не роняет список:** нет источника, таймаут (1 с) или ошибка —
  пустая карта, строки без `emblem`, запись в лог (`public_identity_failed`).
- **Поля `tester` и `supporter` в строках остаются:** старый клиент рисует по
  ним. Новый клиент (T-0236) предпочитает `emblem`.
- **Один вызов на список,** не на строку. Идентификаторы аккаунтов наружу
  по-прежнему не уходят.

## Как сейчас

- `runs/runs-view.service.ts`, `leaderboardFor` (около стр. 109–147,
  `tester` — 138, 169): строка из `details.get(entry.accountId)`; после
  T-0107 — `prestige` через `RunPrestige`, после T-0161 — `supporter`.
- `seasons/seasons-view.service.ts:93` и `dto/seasons.dto.ts:71` — строки
  таблицы сезона с `tester` (после T-0111 — экран сезона).
- `friends/friends.repository.ts:92–99` — `PEER` и `peerOf` с `tester`;
  список собирает `friends.service.ts`.
- После T-0235: `EmblemsService.of(accountIds)` → карта выбранных знаков.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`common/public-identity.ts`** — тип `PublicMark`, интерфейс и класс с
   `provide(source)` и `of(ids)` (таймаут, сбой → пустая карта и лог).
3. **`shared-types`** — `PublicEmblem`, `PublicMark`, поле `emblem?` у строк.
4. **`achievements.module.ts`** — регистрация на `onModuleInit`.
5. **Рейтинг, сезон, друзья** — порт в модули (`runs.module.ts`,
   `seasons.module.ts`, `friends.module.ts`); `emblem` в строки одним вызовом
   на список.
6. **`docs/21`** — порт на схеме связей модулей.

## Чего не трогаем

- Правила знаков и выбор — T-0235. Облик в `PublicMark` — T-0237.
- Клиент — T-0236.
- Поля `tester` и `supporter`.

## Тесты

Первым коммитом.

- `backend/api/test/public-identity.test.ts`:
  - без источника → пустая карта;
  - источник бросил → пустая карта и лог;
  - источник завис дольше таймаута → пустая карта.
- `backend/api/test/public-identity.integration.test.ts` (живые Postgres и Redis):
  - строка рейтинга тестера без выбора — `emblem.id = emb_tester`;
  - выбранный «Последний рубеж» виден в рейтинге, в таблице сезона и у друга;
  - VIP истёк — в строке знак по умолчанию;
  - на список рейтинга из 50 строк — один вызов источника;
  - поля `tester` и `supporter` на месте.

## Аналитика

Нет: строки списков, событий нет.

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Строки рейтинга, сезона и друзей несут знак одним вызовом на список.
- [ ] Сбой источника знаков не роняет список.
- [ ] `tester` и `supporter` в строках сохранены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Знак у имени в строках списков`
- **Метка:** `release: minor`
- **Для игроков:** пусто — до клиента (T-0236) игрок изменений не видит.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗНАК В СТРОКАХ СПИСКОВ**

  Строки рейтинга, сезона и друзей несут знак у имени игрока — выбранный или по умолчанию — одним запросом на весь список через общий порт PublicIdentity. Сбой знаков список не роняет; облик пойдёт тем же портом.
  ```
