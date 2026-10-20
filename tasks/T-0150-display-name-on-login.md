---
id: T-0150
title: Ник чистится при входе — исходник для панели, закрепление, чистка старых
epic: E4
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0149]
zones:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/src/cli/display-names-clean.ts
  - backend/api/package.json
  - backend/api/test/account-name.integration.test.ts
  - backend/api/test/display-names-clean.test.ts
shared:
  - docs/21-diagrams.md
  - docs/08-web-and-identity.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 2
---

# T-0150. Ник чистится при входе — исходник для панели, закрепление, чистка старых

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0150.json)](README.md#значки-статуса) [![T-0149](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0149.json&label=T-0149)](T-0149-display-name-cleaning.md)

## Зачем

T-0149 даёт функцию чистки ника. Эта задача включает её при каждом входе:
игроки в рейтинге и «Друзьях» видят чистый ник, панель — ещё и исходный.
Модератор может закрепить ник (T-0151): вход его больше не перезапишет.

## Решения

Решения пользователя от 15.10.2026: исходный ник хранится и виден только в
панели; ручная смена в панели — с закреплением.

Уточнения `claude-lead-1` от 15.10.2026:

- **Одна точка** — `AccountRepository.upsert`: через неё идут все входы
  (запуск, вход разработчика, вход через бота, вход в панель).
- **Поля аккаунта:** `platformName` — ник с площадки как пришёл (до 256
  символов, обрезка без «…»), обновляется при каждом входе; `nameLockedAt` —
  ник закреплён модератором. Миграция только добавляет nullable-поля
  (expand), откат — удалить два столбца.
- **Закреплённый ник вход не трогает**, а `platformName` обновляет: модератор
  видит, на что игрок сменил ник.
- **Старые аккаунты** чистятся командой `pnpm --filter backend-api names:clean`
  после выката. Без неё ник почистится при следующем входе игрока. У старых
  аккаунтов `platformName` пустой — команда сначала копирует туда нынешний
  `displayName`.

## Как сейчас

- `backend/api/prisma/schema.prisma:162–175` — `Account`: `displayName`
  VarChar(128), `username` VarChar(64).
- `backend/api/src/modules/auth/account.repository.ts:90–107` — `upsert`:
  Prisma `upsert`, `displayName` и в `create`, и в `update`; признак «заведён
  сейчас» — по `createdAt`.
- `backend/api/package.json:13–17` — образец команды CLI (`export`, `wipe`).
- Ники в рейтинге, «Друзьях» и сезонах читаются из базы (`runs-view.service.ts`,
  `seasons-view.service.ts`, `friends.repository.ts`): после чистки они
  показывают новый ник без отдельной пересборки.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция** — в `Account`:
   ```prisma
   /// ник с площадки как пришёл — только для панели (T-0150)
   platformName String?   @map("platform_name") @db.VarChar(256)
   /// ник закреплён модератором: вход его не перезаписывает
   nameLockedAt DateTime? @map("name_locked_at") @db.Timestamptz(3)
   ```
   `prisma migrate dev --create-only` — один раз, проверить, что папка
   миграции одна. Миграцию проверять на `rubezh_migrate_scratch`.
3. **`account.repository.ts`, `upsert`:**
   - `create`: `accountId` генерируется до вызова, `displayName` —
     `displayNameFor(identity.displayName, identity.username, accountId).name`,
     `platformName` — сырой ник (`slice(0, 256)`);
   - `update`: `displayName` **не** пишется, `platformName` — пишется;
   - вторым запросом — `updateMany({ where: { accountId, nameLockedAt: null },
     data: { displayName: clean.name } })`. Одно `UPDATE … WHERE` атомарно и не
     перетирает закрепление, сделанное в панели между двумя запросами;
   - в возвращаемом аккаунте — итоговый ник: закреплён — прежний, нет — чистый.
     Комментарий: почему два запроса, а не один `upsert`.
4. **`cli/display-names-clean.ts`** и команда
   `"names:clean": "node --conditions=source --import @swc-node/register/esm-register src/cli/display-names-clean.ts"`:
   - чистая функция `planCleanup(rows)` → `{ updates: [{ accountId, displayName, platformName }], byVerdict }`;
   - проход по аккаунтам пачками по 500, курсор по `accountId`; закреплённые
     пропускаются; `platformName` пустой — берётся нынешний `displayName`;
   - `--dry-run` — только печать счётчиков по вердиктам;
   - итог — строка `{ module: "names", event: "names_cleaned", byVerdict }`.
5. **Документы:**
   - `docs/21` — ER: два новых поля `Account`;
   - `docs/08` §3 — абзац «Ник»: снимок с площадки чистится (T-0149), исходник
     виден в панели, закреплённый ник вход не меняет, команда для старых.

## Чего не трогаем

- Правила чистки — `display-name.ts` (T-0149).
- Панель: показ исходника и ручная смена — T-0151.
- `username`: хранится как есть, игрокам не показывается.

## Тесты

- `account-name.integration.test.ts` (живой Postgres, своя схема — `docs/17` §4.2):
  - новый аккаунт с ником из U+0489 и `username` `"tolik"` → `displayName`
    `"tolik"`, `platformName` — исходник;
  - повторный вход с «Оленька» → `displayName` «Оленька», `platformName`
    обновлён;
  - `nameLockedAt` задан, вход с другим ником → `displayName` прежний,
    `platformName` новый;
  - признак «заведён сейчас» по-прежнему верен для нового и старого аккаунта;
  - 20 параллельных входов одного аккаунта → один аккаунт, ник чистый.
- `display-names-clean.test.ts` — `planCleanup`:
  - чистый ник → нет в `updates`;
  - ник с матом → «Игрок NNNN», `byVerdict.profanity` 1;
  - закреплённый → пропущен;
  - пустой `platformName` → берётся нынешний ник.

## Аналитика

Событий нет: серверных событий в бэкенде пока нет, клиентские о нике не знают.
Сколько ников почищено — в итоговой строке команды и фильтром в панели (T-0151).

## Настройки и окружение

Нет.

## Документы

Шаг 5.

## Критерии приёмки

- [ ] Вход с ником из декоративных знаков или с матом сохраняет чистый ник, а
  исходник — в `platformName`.
- [ ] Закреплённый ник вход не перезаписывает.
- [ ] `pnpm --filter backend-api names:clean --dry-run` печатает счётчики, без
  флага — чистит.
- [ ] Миграция только добавляет nullable-поля, в описании PR — план отката.
- [ ] Гейт (`CLAUDE.md`) зелёный, интеграционные тесты — на живом Postgres.

## PR

- **Заголовок:** `feat(auth): Чистый ник при входе и исходник для панели`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- исправлено: ники из декоративных знаков и с матом в рейтинге заменяются на читаемые`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НИКИ ЧИСТЯТСЯ ПРИ ВХОДЕ**

  Ник с площадки чистится при каждом входе: в рейтинге и «Друзьях» — читаемый ник, исходный хранится только для панели. Закреплённый модератором ник вход не меняет. Старые аккаунты — командой `names:clean` после выката.

  ❓ **Нужно от команды**

  • @участник1 — после выката на прод запустить `pnpm --filter backend-api names:clean --dry-run`, посмотреть счётчики, затем без `--dry-run`
  ```
