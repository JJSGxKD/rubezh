---
id: T-0139
title: Полный прогон интеграционных тестов проходит и на Windows
epic: E0
priority: P2
status: done
owner: claude-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/test/wipe-runner.integration.test.ts
  - backend/api/test/compensation.integration.test.ts
  - backend/api/test/tester-snapshot.integration.test.ts
shared:
  - docs/17-testing-strategy.md
runner: local
executor: sonnet-5.5
effort: medium
release: none
design: null
batch: 2
---

# T-0139. Полный прогон интеграционных тестов проходит и на Windows

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0139.json)](../README.md#значки-статуса)

## Зачем

Исполнители задач `local` работают на Windows. Полный `pnpm test` с адресами
баз у них не зелёный по причинам вне их задач, и каждый тратит время на разбор
(`tasks/inbox.md`, 14.10). На Linux в CI всё проходит.

## Решения

Решение `claude-lead-1` от 14.10.2026:

1. **`wipe-runner.integration`** запускает Prisma не через `node_modules/.bin/prisma`
   (на Windows там `prisma.cmd`, а `.cmd` без оболочки не запускается), а точкой
   входа пакета через тот же Node: `execFileSync(process.execPath, [<путь к
   prisma/build/index.js>, "migrate", "deploy"], …)`. Путь —
   `createRequire(import.meta.url).resolve("prisma/build/index.js", { paths: [API_DIR] })`.
   Если пакет кладёт вход иначе — взять поле `bin` из его `package.json`.
2. **`tester-snapshot.integration`** не зависит от чужих строк
   `tester_compensation`: тест сверяет только свои аккаунты или чистит свои
   строки сам. А `compensation.integration` в `afterAll` удаляет созданные им
   строки по своим `accountId`. Сначала выяснить, какая проверка снимка
   смотрит на всю таблицу, и записать это в PR.
3. **`max_connections` локального Postgres** — не код: в `docs/17` §4.2
   строка о том, что полный прогон на своей машине —
   `pnpm test -- --maxWorkers=4`. Иначе пулы всех файлов разом упираются в
   предел соединений.

## Как сейчас

- `backend/api/test/wipe-runner.integration.test.ts:272` —
  `execFileSync(resolve(API_DIR, "node_modules/.bin/prisma"), ["migrate", "deploy"], …)`.
- `backend/api/test/compensation.integration.test.ts:45, 160` — создаёт строки
  `testerCompensation` и не удаляет их.
- `backend/api/test/tester-snapshot.integration.test.ts:34–39` — `beforeAll` и
  `afterAll`; строки читает по своим id (строка 179), но падает, когда в таблице
  есть чужие строки.

## Шаги по порядку

1. Воспроизвести локально: полный `pnpm test` с адресами тестовой базы в своей
   схеме (`docs/17` §4.2) — записать, какие файлы падают.
2. Правка 1 — `wipe-runner`.
3. Правка 2 — изоляция `tester-snapshot` и уборка за `compensation`.
4. Строка в `docs/17` — правка 3.
5. Полный прогон дважды подряд — зелёный. Результат — в PR.

## Чего не трогаем

- Код вайпа, компенсации и снимка: только тесты.
- CI (`ci.yml`): на Linux всё и так проходит.

## Тесты

Задача сама про тесты. Критерий — полный прогон.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

`docs/17` §4.2 — правка 3.

## Критерии приёмки

- [ ] `wipe-runner.integration` проходит на Windows и в CI.
- [ ] `tester-snapshot.integration` проходит при любом порядке файлов и после
  `compensation.integration`.
- [ ] Полный `pnpm test` с адресами в своей схеме на Windows — зелёный два раза
  подряд (с `--maxWorkers=4`).

## PR

- **Заголовок:** `test(api): Интеграционные тесты проходят и на Windows`
- **Метка:** `release: none`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОЛНЫЙ ПРОГОН ТЕСТОВ НА WINDOWS**

  Интеграционные тесты проходят целиком и на Windows: тест вайпа запускает Prisma без оболочки, тест снимка тестеров не зависит от чужих строк. Исполнителям задач local больше не нужно разбирать чужие падения.
  ```
