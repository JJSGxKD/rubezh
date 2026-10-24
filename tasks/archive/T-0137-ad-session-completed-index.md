---
id: T-0137
title: Индекс досмотров по времени завершения — для ряда сводки панели
epic: E4
priority: P3
status: done
owner: claude-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/test/ad-session-index.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
runner: local
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0137. Индекс досмотров по времени завершения — для ряда сводки панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0137.json)](../README.md#значки-статуса)

## Зачем

Ряд сводки по суткам (T-0051) считает досмотры рекламы по `ad_session.completed_at`,
а индексы таблицы — по `created_at` и `(account_id, place, created_at)`. Панель
опрашивает сводку раз в минуту, окно до 30 суток, и каждый опрос обходит всю
таблицу показов (находка ревью #284, `tasks/inbox.md`). На закрытом тесте это
незаметно, но таблица показов растёт быстрее всех.

## Решения

- **Обычный индекс `@@index([completedAt])`** через схему Prisma. Таблица
  сейчас небольшая, блокировка на время создания короткая — так же решено для
  индекса забегов в T-0110. Когда таблица вырастет, индексы создаются
  `CONCURRENTLY` отдельной миграцией.
- Запросы не меняются: планировщик сам возьмёт индекс для
  `completed_at >= … AND completed_at < …`.

## Как сейчас

- `backend/api/prisma/schema.prisma`, `model AdSession`: `@@index([accountId, place, createdAt])`,
  `@@index([createdAt])`, поле `completedAt DateTime? @map("completed_at")`.
- `backend/api/src/modules/admin-notify/daily-stats.repository.ts:137–138` —
  `… FROM ad_session WHERE completed_at >= ${from} AND completed_at < ${to} GROUP BY 1`.

## Шаги по порядку

1. **Тест первым коммитом** (раздел «Тесты»).
2. **`schema.prisma`** — в `model AdSession` строка `@@index([completedAt])`
   рядом с остальными индексами.
3. **Миграция** — один раз `prisma migrate dev --create-only` на отдельной базе
   (`docs/17` §4.2, своя схема). Проверить, что папка одна, а в ней только
   `CREATE INDEX "ad_session_completed_at_idx" ON "ad_session"("completed_at");`.
4. Больше ничего не менять.

## Чего не трогаем

- Запросы сводки и воронки рекламы, остальные индексы.

## Тесты

- `backend/api/test/ad-session-index.integration.test.ts` (живой Postgres): в
  `pg_indexes` для таблицы `ad_session` есть индекс по `completed_at`.
  Запрос — к схеме из адреса тестовой базы (`current_schema()`).

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

`docs/21-diagrams.md` — индексы на ER не показываются, менять нечего. Если у
`ad_session` там перечислены индексы — дописать новый.

## Критерии приёмки

- [ ] Миграция одна и создаёт только индекс.
- [ ] Тест индекса проходит на живом Postgres.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `perf(api): Индекс досмотров по времени завершения`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **План отката:** миграция только добавляет индекс. Откат кода её не требует,
  а при нужде индекс удаляется `DROP INDEX`.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СВОДКА ПАНЕЛИ НЕ ОБХОДИТ ВСЮ ТАБЛИЦУ ПОКАЗОВ**

  Ряд досмотров в сводке панели считается по индексу: раньше каждый опрос раз в минуту читал всю таблицу показов рекламы.
  ```
