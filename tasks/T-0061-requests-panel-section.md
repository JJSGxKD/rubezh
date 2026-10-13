---
id: T-0061
title: Раздел «Запросы» в панели — исходящие вызовы и сводка входящих
epic: E13
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0060, T-0049]
zones:
  - backend/api/src/modules/request-journal/request-journal.repository.ts
  - backend/api/src/modules/request-journal/request-journal.service.ts
  - backend/api/src/modules/admin/admin-requests.controller.ts
  - backend/api/test/admin-requests.test.ts
  - apps/admin/src/api/requests.ts
  - apps/admin/src/screens/requests/**
  - apps/admin/src/routes.ts
  - apps/admin/src/screens/sections.tsx
  - apps/admin/test/requests.test.ts
shared:
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/ui/help.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0061. Раздел «Запросы» в панели — исходящие вызовы и сводка входящих

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0061.json)](README.md#значки-статуса) [![T-0060](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0060.json&label=T-0060)](T-0060-request-journal-storage.md) [![T-0049](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0049.json&label=T-0049)](T-0049-admin-shell-responsive.md)

## Зачем

Журнал запросов пишется (T-0060), но смотреть его негде. Решение
пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р92) — раздел
«Запросы» в панели:

- куда и как ходит сервер — по каждому вызову, в том числе через прокси;
- что к нему приходит — сводкой по маршрутам.

## Решения

- **Раздел** `requests` в группе «Эксплуатация», после «Диагностики»:
  - название «Запросы»;
  - подсказка «Куда ходит сервер и что к нему приходит: вызовы внешних API
    и сводка по маршрутам за неделю»;
  - значок `Network`;
  - право `requests.view` — владелец и администратор.
- **Вкладка «Исходящие»:**
  - сверху — сводка по сервисам за период (час, сутки, неделя):
    вызовов, ошибок с долей, медиана и 95-й перцентиль времени, через
    прокси;
  - ниже — последние вызовы таблицей: время, сервис, метод, хост и путь,
    статус или причина сбоя, время, «напрямую» или прокси, попытка;
  - фильтры: сервис, «только ошибки»; постранично по 100.
- **Вкладка «Входящие»:**
  - период: час (по минутам), сутки и неделя (по часам);
  - график всех ответов по времени, 5xx — отдельным рядом;
  - таблица маршрутов: метод и шаблон, ответов, 4xx и 5xx с долей,
    медиана и p95; по умолчанию — по числу ответов;
  - доля 5xx от 1% — тоном опасности.

## Как сейчас

- **Таблицы** (T-0060):
  - `outbound_call`;
  - `inbound_minute` с корзинами;
  - `quantileMs` в `request-journal/journal-rules.ts`.
- **Образец админского контроллера с правом** —
  `backend/api/src/modules/admin/admin-overview.controller.ts`:
  - `AdminSessionGuard`, `PermissionGuard`;
  - `@RequirePermission`.
- **Права** — `backend/api/src/modules/roles/permissions.ts`, новые — своим
  блоком.
- **Панель:**
  - раздел — строка в `SECTION_GROUPS` (`apps/admin/src/routes.ts`, после
    T-0049 — со значком);
  - экран — в `screens/sections.tsx`;
  - таблицы — `DataTable`;
  - графики — Recharts (Р85), образец — экраны со сводкой;
  - пояснения — `ui/help.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Право** `requests.view` — блоком в `permissions.ts`: владелец и
   администратор, описание «Смотреть журнал запросов сервера».
3. **Репозиторий журнала** — чтения:
   - `outboundSummary(from, to)` — по сервисам: `count`, `errors`
     (`ok = false`), `viaProxy` (`via <> 'direct'`), медиана и p95 —
     `percentile_cont` по `duration_ms`;
   - `outboundCalls({ service?, onlyErrors, beforeId?, limit: 100 })` —
     по `id` убыванием;
   - `inboundRoutes(from, to)` — сумма `count` и корзин по маршруту и
     классу статуса;
   - `inboundSeries(from, to, step: "minute" | "hour")` — все ответы и 5xx
     по шагу.
4. **Сервис** `request-journal.service.ts` — периоды `hour | day | week` →
   окна от `now` назад, перцентили из корзин — `quantileMs`.
5. **`admin-requests.controller.ts`** — `/api/v1/admin/requests`:
   - `GET outbound?period=&service=&errors=1&before=`;
   - `GET outbound/summary?period=`;
   - `GET inbound?period=`;

   Всё под `requests.view`, параметры — Zod, чужой период — 400 «Период —
   час, сутки или неделя».
6. **Панель:**
   - `api/requests.ts` — схемы и запросы;
   - раздел в `routes.ts`;
   - экран `screens/requests/RequestsScreen.tsx` с вкладками по «Решениям»;
   - на телефоне (`useNarrow`, T-0049) таблицы — карточками, главное поле —
     путь;
   - пояснения:
     - `HELP.requests.outbound` — «Каждый вызов внешнего API: курсы, Bot API,
       сети рекламы, постбэки. Попытка через прокси — отдельной строкой»;
     - `HELP.requests.inbound` — «Ответы сервера по маршрутам — без адресов и
       игроков. Медиана и p95 — по корзинам времени, с точностью до границы
       корзины».
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Запись журнала (T-0060).
- «Диагностику» и её записи забегов.

## Тесты

Первым коммитом.

- **`backend/api/test/admin-requests.test.ts`:**
  - без `requests.view` — 403;
  - `period=year` — 400;
  - сводка по подменённому репозиторию:
    - доля ошибок;
    - перцентили из корзин;
  - страницы `outbound` — `before` отдаёт следующую сотню.
- **`apps/admin/test/requests.test.ts`:**
  - разбор ответов;
  - помощник доли 5xx → тон: 0,9% — обычный, 1% — опасность.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- **`docs/29-admin-panel.md`** — строка раздела «Запросы» в таблице
  разделов: что видно, право, хранение 7 суток.

## Критерии приёмки

- [ ] Раздел «Запросы» виден с правом `requests.view`.
- [ ] «Исходящие» — сводка по сервисам и вызовы с фильтрами.
- [ ] «Входящие» — график и маршруты за час, сутки, неделю.
- [ ] На телефоне — без горизонтальной прокрутки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Раздел «Запросы» — журнал входящих и исходящих`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РАЗДЕЛ «ЗАПРОСЫ» В ПАНЕЛИ**

  В панели появился раздел «Запросы»: каждый вызов сервера к внешним API — куда, с каким исходом, напрямую или через прокси — и сводка входящих по маршрутам с ошибками и временем ответа за час, сутки или неделю.
  ```
