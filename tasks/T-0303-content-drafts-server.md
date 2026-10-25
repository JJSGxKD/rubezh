---
id: T-0303
title: Контент на сервере — версии и черновики в базе, версия 0 из репозитория, правка черновика, проверка через sim-worker и разница с базой
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0302]
zones:
  - backend/api/src/modules/content/**
  - backend/api/src/modules/admin/admin-content.controller.ts
  - backend/api/src/cli/content-import.ts
  - backend/api/test/content-drafts.test.ts
  - backend/api/test/content-drafts.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/package.json
  - backend/api/src/app.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/admin/admin-limits.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - docs/19-content-admin.md
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/mockups/admin-balance.html
batch: 7
---

# T-0303. Контент на сервере — версии и черновики в базе, версия 0 из репозитория, правка черновика, проверка через sim-worker и разница с базой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0303.json)](README.md#значки-статуса) [![T-0302](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0302.json&label=T-0302)](T-0302-sim-worker.md)

## Зачем

Песочница редактора баланса (шаг 1, решение 25.10.2026) — геймдизайнер
правит числа в панели и сразу видит, что станет с забегом, не трогая
игроков. Серверу для этого нужно:
- версии контента — пока одна, из репозитория;
- черновики поверх версии;
- правка черновика;
- проверка через `sim-worker`;
- разница с базой.

Публикации здесь нет — шаг 2 (T-0306).

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р16 — снимок хранится в базе по хэшу;
- 25.10.2026:
  - фаза 1 `docs/19` в два шага, шаг 1 — песочница;
  - в первой волне — враги и таймлайн, оружие и навыки, подборы, сундуки и
    опыт, цены и награды (T-0309).

Решения `claude-lead-1` от 25.10.2026:

- **Таблицы:**
  - `content_version`: `version_no` serial, `content_hash` уникален,
    `schema_version`, `snapshot jsonb`, `json_schema jsonb`, `names jsonb`,
    `source` (`repo` | `panel`), `created_by`, `created_at`, `published_at null`;
  - `content_draft`: `draft_id` uuid, `base_version_no`, `title` до 80,
    `snapshot jsonb`, `author`, `updated_at`, `archived_at`;
  - `content_check`: `check_id`, `draft_id`, `snapshot_hash`, `status`
    (`queued` | `done` | `failed` | `timeout`), `report jsonb`, `created_at`.
- **Версия 0** — `pnpm --filter backend-api content:import <файл>`:
  - читает выгрузку `content:export` (T-0301): снимок, JSON Schema и имена;
  - заводит версию с `source: repo`;
  - тот же хэш — ничего не делает.

  Код-PR, который меняет `content/*`, после выката заводит новую версию
  `repo` этой же командой (шаг деплоя — в T-0306).
- **Черновик** — копия снимка версии. Правка:
  - `PATCH` по пути (`enemies[id=swarm_rat].hp`, `timeline[3].spawns[0].perSec`);
  - форма значения — по схеме снимка;
  - не та форма — 422 с путём, черновик не меняется.

  Схему снимка сервер не дублирует: она едет вместе с выгрузкой
  `content:export` как JSON Schema (`z.toJSONSchema`) и проверяется на
  сервере ею. Полная проверка (`findContentProblems`) — в воркере.
- **Проверка** — `POST /api/v1/admin/content/drafts/:id/check`:
  - ставит задание `content-check` с черновиком и базой;
  - ответ — `checkId`, статус — `GET /checks/:checkId`;
  - повтор с тем же `snapshot_hash` — прошлый отчёт, без нового прогона.
- **Разница** — `GET /drafts/:id/diff` → список `{ path, from, to }` против базы.
- **Права:**
  - `content.view` — читать;
  - `content.edit` — черновики и проверка;
  - цены и награды — `sku.price.edit` (T-0309).
- **Лимиты** — проверка не чаще 10 за 10 минут на человека
  (`ADMIN_LIMITS.contentCheck`).
- **Аудит** — создание, правка (путь, было → стало), проверка, архив
  черновика.
- **Очистка** — таблицы в `wipe-plan.ts` как `keep`: это правила игры, а не
  данные игроков.

## Как сейчас

- **Права** `content.view`, `content.edit`, `content.publish` есть у ролей
  (`roles/permissions.ts`, роль `game_designer`), модуля `content` нет.
- **Аудит** — модель `AuditEntry`; запись — как у других действий панели.
- **После T-0301** — `content:export`; **после T-0302** — очередь
  `content-check` и формат отчёта.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — три таблицы; ER в `docs/21`; строки в `wipe-plan.ts`.
3. **`cli/content-import.ts`** — версия из выгрузки.
4. **Модуль `content`**:
   - репозиторий;
   - сервис черновиков (правка по пути, проверка формы JSON Schema);
   - постановка проверки и чтение отчёта;
   - разница.
5. **Маршруты** — `admin-content.controller.ts`; лимит; аудит.
6. **Документы:**
   - `docs/19` §3 — черновики и проверка;
   - `docs/29` — раздел «Баланс», сервер.

## Чего не трогаем

- Публикацию, версии для клиента — T-0306, T-0307.
- Панель — T-0304, T-0305.

## Тесты

Первым коммитом.

- `content-drafts.test.ts`:
  - правка по пути — значение на месте, остальное не тронуто;
  - путь к несуществующему врагу → 422;
  - строка вместо числа → 422 с путём;
  - разница двух снимков — только изменённые пути.
- `content-drafts.integration.test.ts`:
  - импорт версии 0, повторный импорт того же файла — без новой версии;
  - черновик → правка → проверка ставит задание; повтор с тем же снимком —
    прошлый отчёт;
  - без `content.edit` → 403;
  - 11-я проверка за 10 минут → 429;
  - аудит пишет путь и «было → стало».

## Аналитика

Нет событий игрока: действия — в аудите.

## Настройки и окружение

Нет новых переменных: Redis и очередь — общие.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Версии и черновики контента в базе; версия 0 — из репозитория.
- [ ] Правка черновика по пути с проверкой формы; проверка через `sim-worker`; разница с базой.
- [ ] Права, лимиты, аудит.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Черновики контента и проверка`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЧЕРНОВИКИ КОНТЕНТА**

  Сервер хранит версии контента и черновики поверх них: правка числа по пути с проверкой, прогон черновика через sim-worker и разница с базой. Публикации пока нет — это песочница для редактора баланса.
  ```
