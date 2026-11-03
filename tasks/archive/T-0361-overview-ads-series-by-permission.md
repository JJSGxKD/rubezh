---
id: T-0361
title: Сводка панели — досмотры рекламы в ряду дней только с правом `ads.view`
epic: E7
priority: P2
status: done
owner: claude-10 / sonnet-5.5 / low
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/admin/admin-overview.service.ts
  - backend/api/test/admin-overview.test.ts
  - apps/admin/src/api/overview.ts
  - apps/admin/test/overview.test.ts
shared:
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: low
release: patch
merge: lead
design: null
batch: 4
---

# T-0361. Сводка панели — досмотры рекламы в ряду дней только с правом `ads.view`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0361.json)](../README.md#значки-статуса)

## Зачем

Плитку рекламы в сводке видят только роли с `ads.view`. Но число досмотров
по дням (`adsCompleted` в ряду `series`) сервер отдаёт всем, у кого есть
`analytics.gameplay.view`. Графика без права не видно, а данные в ответе
есть. После задачи досмотры в ряду приходят только тем, кому открыта реклама.

## Решения

Приёмка #284 (входящие 13.10). Решение `claude-lead-1` от 01.11.2026:
`adsCompleted` в точке ряда — `null` без `ads.view`, так же, как `stars` и
`purchases` без `analytics.revenue.view`. Панель уже рисует график показов,
только когда `overview.ads !== null`; схема панели принимает `null`.

## Как сейчас

- `backend/api/src/modules/admin/admin-overview.service.ts:143` — ряд:
  `stars` и `purchases` скрыты по праву, `adsCompleted` — нет.
- `apps/admin/src/api/overview.ts:74` — `adsCompleted: z.number().default(0)`.
- `apps/admin/src/screens/overview/OverviewScreen.tsx:149` — график
  показов при `overview.ads !== null`.

## Шаги по порядку

1. Тесты первым коммитом.
2. Сервер — `adsCompleted: can.has("ads.view") ? point.adsCompleted : null`.
   Тип точки ряда в ответе — `number | null`.
3. Панель — схема `z.number().nullable()`; места, где читается
   `adsCompleted`, — через `?? 0`, как у `stars`.

## Чего не трогаем

Плитку рекламы и её права; ежедневный отчёт в чат.

## Тесты

- `backend/api/test/admin-overview.test.ts`: роль без `ads.view` → у всех
  точек `adsCompleted === null`; с `ads.view` — числа.
- `apps/admin/test/overview.test.ts`: схема принимает `adsCompleted: null`.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

`docs/29-admin-panel.md` — в таблице прав сводки: досмотры по дням — с
`ads.view`.

## Критерии приёмки

- [ ] Без `ads.view` досмотров в ответе сводки нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(admin): Досмотры в сводке только с правом рекламы`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОСМОТРЫ ПО ПРАВУ**

  Число досмотров рекламы по дням в сводке панели теперь приходит только ролям с правом на рекламу, как и плитка рекламы.
  ```
