---
id: T-0060
title: Журнал запросов — исходящие по вызову, входящие сводкой по маршрутам, 7 дней
epic: E13
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0059]
zones:
  - backend/api/src/infra/outbound/outbound.module.ts
  - backend/api/src/modules/request-journal/**
  - backend/api/src/http-app.ts
  - backend/api/test/request-journal.test.ts
  - backend/api/test/request-journal.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/app.module.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
---

# T-0060. Журнал запросов — исходящие по вызову, входящие сводкой по маршрутам, 7 дней

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0060.json)](README.md#значки-статуса) [![T-0059](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0059.json&label=T-0059)](T-0059-outbound-http-client.md)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р92): команде не
видно, какие запросы приходят на сервер и какие уходят наружу — в том числе
через прокси. Нужен раздел «Запросы» в панели, без новых сервисов на
сервере.

Задача — **хранение**:

- исходящие вызовы — каждый, из клиента T-0059;
- входящие — сводкой по маршрутам за минуту;
- уборка через 7 дней.

Раздел панели — T-0061.

## Решения

- **Исходящие — каждая попытка строкой** `outbound_call`.
  - Пишутся пачками: клиент T-0059 кладёт запись в буфер процесса, раз в 5
    секунд буфер уходит одним `createMany`.
  - Буфер не больше 2000 записей; лишние отбрасываются со счётчиком и
    `warn` раз в минуту. Журнал — наблюдение, а не учёт: потерять часть
    строк при всплеске лучше, чем притормозить вызов.
- **Входящие — сводка, а не запросы.** Адресов и идентификаторов игроков нет
  (`CLAUDE.md`, «Аналитика»: низкая кардинальность).
  - Ключ сводки — минута, метод, шаблон маршрута (`/api/v1/runs/:runId`, не
    адрес) и класс статуса (`2xx`, `3xx`, `4xx`, `5xx`).
  - Значения — число и время по корзинам: 25, 50, 100, 250, 500, 1000,
    2500, 5000 мс и «дольше». Из корзин считаются медиана и 95-й
    перцентиль.
- **Счёт входящих — в Redis**, атомарно (`HINCRBY`): ключ на минуту,
  поле на маршрут и корзину, срок жизни 2 часа.
  - Раз в минуту задание под распределённым локом переносит прошедшие минуты
    в Postgres `inbound_minute` и удаляет ключ.
  - Redis лёг — запрос игрока не ждёт и не падает, минута теряется.
- **Хранение — 7 суток.** Уборка раз в сутки, пачками по 5000 строк.
- **Свои служебные маршруты** (`/health`, `/health/ready`) в сводку не
  входят: проверки раз в 10 секунд заглушили бы картину.

## Как сейчас

- **Клиент исходящих** (после T-0059) — `backend/api/src/infra/outbound/`:
  - `Outbound`;
  - приёмник `OUTBOUND_SINK` = `NOOP_SINK`;
  - запись `OutboundRecord`.
- **`backend/api/src/http-app.ts`:**
  - хуки Fastify;
  - `onResponse` уже считает ответы 5xx для тревоги (T-0035, строки ~74–90) —
    образец.
- **Распределённый лок и задание раз в минуту** — образец
  `modules/fx/fx.refresher.ts`:
  - `LOCK_KEY`, `RELEASE_SCRIPT`, токен лока;
  - `OnApplicationBootstrap`, `OnModuleDestroy`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (процедура — «Общие файлы» в `tasks/README.md`):

   ```prisma
   // Журнал исходящих запросов (docs/35-stage4-plan.md Р92, T-0060): попытка — строка, 7 суток.
   model OutboundCall {
     id         BigInt   @id @default(autoincrement())
     at         DateTime @db.Timestamptz(3)
     service    String   @db.VarChar(32)
     method     String   @db.VarChar(8)
     host       String   @db.VarChar(128)
     path       String   @db.VarChar(256)
     status     Int?     @db.SmallInt
     ok         Boolean
     durationMs Int      @map("duration_ms")
     via        String   @db.VarChar(40)
     attempt    Int      @db.SmallInt
     error      String?  @db.VarChar(16)
     @@index([at(sort: Desc)])
     @@index([service, at(sort: Desc)])
     @@map("outbound_call")
   }

   // Сводка входящих по минутам (Р92): без адресов и игроков.
   model InboundMinute {
     minute      DateTime @db.Timestamptz(0)
     method      String   @db.VarChar(8)
     route       String   @db.VarChar(160)
     statusClass String   @map("status_class") @db.VarChar(3)
     count       Int
     /// число ответов по корзинам времени LATENCY_BUCKETS_MS и «дольше» — последней
     buckets     Int[]
     @@id([minute, method, route, statusClass])
     @@index([route, minute(sort: Desc)])
     @@map("inbound_minute")
   }
   ```

3. **Новый модуль `backend/api/src/modules/request-journal/`** — по скиллу
   `new-backend-module`:
   - `journal-rules.ts` — чистые функции и числа:

     ```ts
     export const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
     export const JOURNAL_KEEP_DAYS = 7;
     export const OUTBOUND_BUFFER_MAX = 2000;
     export function bucketOf(durationMs: number): number;          // индекс корзины, «дольше» — последний
     export function statusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx";
     export function quantileMs(buckets: readonly number[], q: number): number | null; // верхняя граница корзины, где набралась доля q
     export function minuteKey(at: Date): string;                    // `inbound:m:YYYYMMDDHHmm` по UTC
     ```

   - `outbound-sink.ts` — `BufferedOutboundSink implements OutboundSink`:
     буфер, сброс раз в 5 с и при остановке процесса, лимит, счётчик
     отброшенных;
   - `inbound-counter.ts` — `count(method, route, status, durationMs)` →
     `HINCRBY` двух полей (число и корзина) и `EXPIRE` 7200; ошибки Redis
     — `warn` раз в минуту, не дальше;
   - `journal.rollup.ts` — раз в минуту под локом `request-journal:lock`:
     - минуты старше текущей → `inbound_minute` (`upsert` с прибавлением —
       повтор переноса не задваивает: ключ удаляется после записи);
     - раз в сутки — уборка обеих таблиц старше `JOURNAL_KEEP_DAYS`, пачками
       по 5000;
   - `request-journal.repository.ts` — Prisma только здесь;
   - `request-journal.module.ts` — провайдер `OUTBOUND_SINK` →
     `BufferedOutboundSink`.
4. **`outbound.module.ts`** — `NOOP_SINK` остаётся умолчанием для тестов;
   в приложении приёмник даёт модуль журнала.
5. **`http-app.ts`** — `onResponse`:
   - `inboundCounter.count(request.method, request.routeOptions.url ?? "(нет маршрута)", reply.statusCode, reply.elapsedTime)`;
   - без `/health*`;
   - не ждать промис: ответ игроку уже ушёл.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Тревогу 5xx (T-0035).
- Клиент исходящих: только приёмник.
- Логи процесса.

## Тесты

Первым коммитом.

- **`backend/api/test/request-journal.test.ts`:**
  - `bucketOf`: 10 → 0, 25 → 0, 26 → 1, 5000 → 7, 9000 → 8;
  - `statusClass`: 204 → `2xx`, 302 → `3xx`, 429 → `4xx`, 503 → `5xx`;
  - `quantileMs`:
    - 90 ответов в корзине 50 мс и 10 в 1000 мс → медиана 50, p95 1000;
    - пусто → `null`;
  - `minuteKey(2026-10-12T13:05:59Z)` → `inbound:m:202610121305`;
  - `BufferedOutboundSink`:
    - 2001-я запись отброшена, счётчик — 1;
    - сброс отдаёт пачку и очищает буфер.
- **`backend/api/test/request-journal.integration.test.ts`** (`runner: local`,
  Postgres и Redis 13):
  - три ответа в минуту → после переноса одна строка с `count: 3` и
    корзинами;
  - повторный перенос той же минуты не задваивает;
  - строки старше 7 суток удаляются, новее — остаются;
  - `/health` не попадает в сводку.

## Аналитика

Нет: это наблюдение за сервером, не события игрока.

## Настройки и окружение

Нет. Числа — в `journal-rules.ts`.

## Документы

- **`docs/21-diagrams.md`** — ER: `outbound_call`, `inbound_minute`.
- **`docs/30-configuration-map.md`** — строка: журнал запросов, хранение и
  корзины — `modules/request-journal/journal-rules.ts`.

## Критерии приёмки

- [ ] Каждый исходящий вызов через клиент — строка `outbound_call`;
  ответ игроку и вызов этого не ждут.
- [ ] Входящие — по минутам, маршрутам и классам статуса, с корзинами
  времени, без адресов.
- [ ] Уборка старше 7 суток работает.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты на живых
  Postgres и Redis зелёные.

## PR

- **Заголовок:** `feat(api): Журнал входящих и исходящих запросов`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЖУРНАЛ ЗАПРОСОВ: ХРАНЕНИЕ**

  Сервер записывает каждый свой запрос к внешним API — куда, с каким исходом, сколько длился — и сводку входящих по маршрутам за минуту. Хранится неделю. Смотреть — в разделе «Запросы» панели, он следующей задачей.
  ```
