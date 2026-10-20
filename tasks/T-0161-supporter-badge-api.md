---
id: T-0161
title: Знак «Поддержал проект» в ответах входа, рейтинга и сезонов — сервер
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0157, T-0191, T-0193]
zones:
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/src/modules/auth/auth.controller.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/seasons/seasons.repository.ts
  - backend/api/src/modules/seasons/seasons-view.service.ts
  - backend/api/src/modules/seasons/dto/seasons.dto.ts
  - packages/shared-types/src/index.ts
  - backend/api/test/helpers/memory-auth.ts
  - backend/api/test/auth.test.ts
  - backend/api/test/runs.integration.test.ts
shared: []
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0161. Знак «Поддержал проект» в ответах входа, рейтинга и сезонов — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0161.json)](README.md#значки-статуса) [![T-0157](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0157.json&label=T-0157)](T-0157-donations-backend.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md)

## Зачем

Р109 (`docs/35-stage4-plan.md`, 19.10.2026): поддержавшему проект показывается
знак «Поддержал проект» в профиле и рейтинге. T-0157 ставит и снимает знак
(колонка `account.supporter_at`), эта задача отдаёт его клиенту: в ответе входа,
в строках рейтинга и в таблице сезона. Экраны — T-0158.

## Решения

- Решение claude-lead-1 от 19.10.2026: показ знака вынесен из T-0157 в эту
  задачу; она зависит от T-0157 (колонка `supporter_at` и поле `supporterAt`
  модели `Account` появляются там). Зоны T-0157 и T-0161 не пересекаются.
- **Знак в ответах** — поле `supporter: true`, только у поддержавшего, нет
  поля — не поддержал. Дата наружу не уходит. Форма — как у `tester`.
- Знак показывается во входе, рейтинге и сезонах. Друзья и прочие места со
  знаком «Тестер» не трогаем (Р109: профиль и рейтинг).

## Как сейчас

Знак «Тестер» — образец сквозного флага: `Account.testerAt`
(`schema.prisma:176`), `auth/account.repository.ts:37,185,199`,
`auth/auth.controller.ts:152–166`, `runs/runs.repository.ts:353–360` и
`:386–394`, `runs/runs-view.service.ts:138,169`,
`seasons/seasons.repository.ts:96–103`, `seasons/seasons-view.service.ts:93`,
`seasons/dto/seasons.dto.ts:71`, типы `packages/shared-types/src/index.ts`
(`LeaderboardEntry`, `AuthAccount`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Знак — сквозной флаг по образцу тестера**:
   - `account.repository.ts` — `supporterAt?: Date | null` в `Account`,
     `AccountRow`, `toAccount`, и в выборках, где сейчас читается `testerAt`;
   - `auth.controller.ts:152–166` — `...(result.account.supporterAt ? { supporter: true as const } : {})`
     рядом с `tester`;
   - `runs.repository.ts:353–360`, `:386–394` — `supporterAt` в выборке
     `account`, `supporter: true` в строке; тип строки (`:89`) и
     `runs-view.service.ts:42,138,169` — поле дальше в ответ;
   - `seasons.repository.ts:96–103`, `seasons-view.service.ts:93`,
     `dto/seasons.dto.ts:71` — то же;
   - `packages/shared-types/src/index.ts` — `supporter?: true | undefined` в
     `LeaderboardEntry` и `AuthAccount`, комментарий «поддержал проект
     (Р109); нет поля — не поддержал».
   Друзья и прочие места со знаком «Тестер» — не трогаем (Р109: профиль и
   рейтинг).

## Чего не трогаем

- Выдачу и снятие знака, покупку `donation`, миграцию, ключи панели, слайд
  главной: T-0157.
- Клиент (`packages/app-shell`): рисует знак T-0158.
- Друзья, уведомления и прочие места со знаком «Тестер».

## Тесты

Пишутся первым коммитом, до кода.

- `auth.test.ts` (`memory-auth.ts`): вход с `supporterAt` →
  `account.supporter === true`, без — поля нет.
- Строки рейтинга и сезонов несут `supporter: true` только у поддержавшего
  (подмены репозиториев в тестах рейтинга и сезонов).
- `runs.integration.test.ts` (живой Postgres): строка рейтинга поддержавшего
  несёт `supporter`, у остальных поля нет.

## Аналитика

Нет: новых событий нет, знак — часть существующих ответов.

## Настройки и окружение

Нет.

## Документы

Нет: форма ответов описана типами `shared-types`; ER и ключи — в T-0157.

## Критерии приёмки

- [ ] `supporter: true` приходит во входе, в рейтинге и в таблице сезона только у
  поддержавшего; у остальных поля нет.
- [ ] Дата выдачи знака наружу не уходит.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные, интеграционный тест — на
  живом Postgres.

## PR

- **Заголовок:** `feat(auth): Знак «Поддержал проект» в ответах сервера`
- **Метка:** `release: minor`
- **Для игроков:** нет — знак появится на экранах с задачей клиента (T-0158)
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗНАК «ПОДДЕРЖАЛ ПРОЕКТ» В ОТВЕТАХ СЕРВЕРА**

  Сервер отдаёт знак «Поддержал проект» во входе, в строках рейтинга и в таблице сезона. Знак ставит и снимает задача про донаты, эта только показывает его клиенту.
  ```
