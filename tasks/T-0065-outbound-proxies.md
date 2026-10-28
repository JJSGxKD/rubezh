---
id: T-0065
title: Прокси для исходящих запросов — список в панели, перебор после неудачи напрямую
epic: E13
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0060, T-0061]
zones:
  - backend/api/src/infra/outbound/**
  - backend/api/src/modules/proxies/**
  - backend/api/src/modules/admin/admin-proxies.controller.ts
  - backend/api/test/outbound-proxy.test.ts
  - backend/api/test/proxies.test.ts
  - backend/api/test/proxies.integration.test.ts
  - apps/admin/src/api/proxies.ts
  - apps/admin/src/screens/proxies/**
  - apps/admin/test/proxies.test.ts
shared:
  - backend/api/package.json
  - pnpm-lock.yaml
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/app.module.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/ui/help.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
  - apps/admin/src/routes.ts
  - apps/admin/src/screens/sections.tsx
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0065. Прокси для исходящих запросов — список в панели, перебор после неудачи напрямую

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0065.json)](README.md#значки-статуса) [![T-0060](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0060.json&label=T-0060)](archive/T-0060-request-journal-storage.md) [![T-0061](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0061.json&label=T-0061)](archive/T-0061-requests-panel-section.md)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р91): часть
внешних API может быть недоступна с адреса сервера — блокировка по стране,
сеть поставщика лежит. Тогда запрос должен пройти через прокси, а команда —
видеть, как он прошёл.

## Решения

- **Прокси — список в панели** (раздел «Прокси», группа «Эксплуатация»):
  - название, схема `http`, `https` или `socks5`, адрес, порт;
  - логин и пароль — пароль шифртекстом тем же `SecretCipher`, что ключи
    интеграций (Р84), назад не показывается;
  - страна (ISO-код из двух букв, вводится руками), включён ли, порядок,
    заметка;
  - результат последней проверки.
- **Режим у каждого сервиса** клиента исходящих (`OUTBOUND_SERVICES`, T-0059):

  | Режим | Что делает |
  |---|---|
  | `direct_first` (умолчание) | сначала напрямую, не вышло — прокси по порядку |
  | `proxy_only` | только через прокси: прямой путь заведомо закрыт, ждать его таймаут незачем |
  | `direct_only` | только напрямую: Bot API и то, что прокси видеть не должен |

  Умолчание у `telegram.bot` — `direct_only`: токен бота в адресе не
  уходит чужому серверу, пока команда не решит иначе.
- **Что считается неудачей** для перехода к прокси:
  - сетевой сбой;
  - таймаут попытки;
  - ответ `403` или `451` (отказ по стране).

  Прочие ответы, в том числе `5xx`, — ответ сервиса: прокси его не
  исправит.
- **Время.**
  - Сигнал вызывающего — общий предел на все попытки.
  - Когда есть куда переходить, у прямой попытки свой предел — 3 с, у
    попытки через прокси — 5 с.
  - Тело запроса — только строка или байты: поток повторно не отправить, и
    запрос с ним идёт одной попыткой.
- **Запоминается, что сработало**: прокси, через который сервис прошёл,
  первым пробуется следующие 10 минут (`outbound:route:<сервис>` в Redis).
  Лишний таймаут на каждом вызове не нужен.
- **Каждая попытка — в журнал** (T-0060): `via` — `direct` или id прокси.
- **«Проверить»** у прокси — запрос `https://api.ipify.org?format=json`
  через него: виден внешний адрес и время ответа; результат сохраняется.
- **Туннели** (VLESS/Xray, WireGuard) — отдельным контейнером с локальным
  SOCKS5. Здесь это обычный прокси `socks5://<сервис>:<порт>`; сам
  контейнер — отдельная задача эксплуатации, когда понадобится первый
  туннель.
- **Права**:
  - смотреть — `proxies.view` (владелец, администратор);
  - менять и проверять — `proxies.edit` (владелец).

  Аудит — с названием и адресом, без пароля.

## Как сейчас

- **Клиент исходящих** `backend/api/src/infra/outbound/` (T-0059, T-0060):
  - `Outbound.forService(service)` — `fetch` с меткой сервиса;
  - запись попытки `OutboundRecord` (`via`, `attempt`);
  - каталог `OUTBOUND_SERVICES`.
- **Шифрование** — `backend/api/src/modules/secrets/secret-cipher.ts`
  (`SecretCipher`, `SealedSecret`), ключ — `SECRETS_ENCRYPTION_KEY`. Без него
  хранилище выключено, и панель так и пишет (Р53). Так же и здесь: без ключа
  прокси с паролем не сохранить.
- **Раздел панели** — строка в `SECTION_GROUPS` (`apps/admin/src/routes.ts`)
  и экран в `screens/sections.tsx`. Образец списка с диалогом —
  `screens/secrets/`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Зависимости** в `backend/api/package.json`, точные версии:
   - `undici` `8.11.2`: `ProxyAgent` и `fetch` с `dispatcher`;
   - `fetch-socks` `1.3.3`: SOCKS5 для `undici`.

   Обе MIT. `pnpm install` — в коммит идёт записанный им `pnpm-lock.yaml`.
3. **Миграция:**

   ```prisma
   // Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, T-0065).
   model OutboundProxy {
     proxyId      String    @id @map("proxy_id") @db.Uuid
     name         String    @db.VarChar(60)
     scheme       String    @db.VarChar(8)
     host         String    @db.VarChar(255)
     port         Int
     username     String?   @db.VarChar(128)
     /// пароль — шифртекстом SecretCipher; отпечаток ключа — для перешифровки
     passwordIv   Bytes?    @map("password_iv")
     passwordTag  Bytes?    @map("password_tag")
     passwordCt   Bytes?    @map("password_ct")
     passwordKeyId String?  @map("password_key_id") @db.VarChar(16)
     country      String    @db.VarChar(2)
     enabled      Boolean
     priority     Int
     note         String?   @db.VarChar(200)
     lastCheckAt  DateTime? @map("last_check_at") @db.Timestamptz(3)
     lastCheckOk  Boolean?  @map("last_check_ok")
     lastCheckNote String?  @map("last_check_note") @db.VarChar(200)
     updatedBy    String    @map("updated_by") @db.Uuid
     updatedAt    DateTime  @map("updated_at") @db.Timestamptz(3)
     @@map("outbound_proxy")
   }

   // Режим сервиса клиента исходящих (Р91): строки нет — умолчание из кода.
   model OutboundServiceMode {
     service   String   @id @db.VarChar(32)
     mode      String   @db.VarChar(16)
     updatedBy String   @map("updated_by") @db.Uuid
     updatedAt DateTime @map("updated_at") @db.Timestamptz(3)
     @@map("outbound_service_mode")
   }
   ```

4. **`infra/outbound/`:**
   - `outbound-route.ts` — чистые функции:

     ```ts
     export type OutboundMode = "direct_first" | "proxy_only" | "direct_only";
     export const DIRECT_ATTEMPT_MS = 3_000;
     export const PROXY_ATTEMPT_MS = 5_000;
     export const ROUTE_MEMORY_SEC = 600;
     /** Порядок попыток: «direct» и id прокси; запомненный прокси — первым среди прокси. */
     export function attemptPlan(mode: OutboundMode, proxies: readonly { id: string; priority: number }[], remembered: string | null): string[];
     /** Переходить ли к следующей попытке после этого исхода. */
     export function shouldFallBack(outcome: { status: number | null; error: string | null }): boolean;
     ```

   - `proxy-dispatcher.ts` — `dispatcherFor(proxy)`:
     - `http` и `https` — `ProxyAgent` с логином в `token` Basic;
     - `socks5` — `socksDispatcher`;
     - кэш по id и `updatedAt`;
   - `Outbound.forService` — по `attemptPlan`:
     - каждая попытка — с сигналом
       `AbortSignal.any([сигнал вызывающего, AbortSignal.timeout(предел)])`;
     - через прокси — `undici.fetch` с `dispatcher`;
     - напрямую — как раньше;
     - успех через прокси — запомнить; запись в журнал на каждую попытку;
     - ответ — первый, где `shouldFallBack` ложно, или последний;
   - список прокси и режимы — из модуля прокси через порт `OutboundRoutes`
     (`list()`, `modeOf(service)`), кэш в памяти на 30 с и сброс
     сообщением Redis при правке, как у ключей интеграций.
5. **Новый модуль `backend/api/src/modules/proxies/`** — по скиллу
   `new-backend-module`:
   - репозиторий;
   - сервис с аудитом (`proxies.create`, `proxies.update`, `proxies.check`,
     `outbound.mode`);
   - проверка — запрос из «Решений» через этот прокси, сеть с таймаутом
     5 с, итог — в `last_check_*`.
6. **`admin-proxies.controller.ts`** — `/api/v1/admin/proxies`:
   - список;
   - создание и правка (пароль — только запись: пустое поле — не менять;
     «Удалить пароль» — явно);
   - `POST :id/check`;
   - `GET modes`, `PUT modes/:service`.

   Zod:
   - схема — из трёх;
   - порт 1…65535;
   - страна `^[A-Z]{2}$`;
   - хост — домен или IP без схемы.
7. **Права** `proxies.view`, `proxies.edit` — блоком в `permissions.ts`.
8. **Панель** — раздел `proxies` в «Эксплуатации»:
   - название «Прокси»;
   - подсказка «Через что сервер ходит к внешним API, если напрямую не
     достучаться»;
   - значок `Waypoints`;
   - экран:
     - список прокси с проверкой;
     - диалог добавления и правки;
     - таблица режимов сервисов;
   - пояснение `HELP.proxies.modes` — «Сначала напрямую — прокси пробуются,
     только если прямой запрос не прошёл: сеть, таймаут, отказ по стране.
     Только через прокси — когда прямой путь заведомо закрыт».
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Места вызова сервисов: они уже ходят через клиент (T-0059).
- Журнал и раздел «Запросы» — только поле `via` заполняется по-настоящему.
- Контейнер-туннель — отдельная задача эксплуатации.

## Тесты

Первым коммитом.

- **`backend/api/test/outbound-proxy.test.ts`:**
  - `attemptPlan`:
    - `direct_first` с двумя прокси → `[direct, p1, p2]` по порядку;
    - запомнен `p2` → `[direct, p2, p1]`;
    - `proxy_only` → без `direct`;
    - `direct_only` → только `direct`;
    - прокси нет → `[direct]`;
  - `shouldFallBack`:
    - сеть, таймаут, 403, 451 → `true`;
    - 200, 404, 500 → `false`;
  - клиент на подменах:
    - прямой упал по сети, первый прокси ответил 200 → вызывающий получил
      200, две записи в журнале (`direct`, id прокси), прокси запомнен;
    - тело — поток → одна попытка.
- **`backend/api/test/proxies.test.ts`:**
  - пароль не возвращается в ответах и аудите;
  - пустое поле пароля при правке — пароль прежний;
  - Zod-отказы: схема, порт, страна;
  - без `proxies.edit` — 403.
- **`backend/api/test/proxies.integration.test.ts`** (Postgres, Redis 13):
  - пароль хранится шифртекстом и расшифровывается тем же ключом;
  - режим сервиса из базы сильнее умолчания.
- **`apps/admin/test/proxies.test.ts`** — разбор списка и режимов,
  проверка вида хоста до отправки.

## Аналитика

Нет: попытки — в журнале запросов (T-0060).

## Настройки и окружение

Нет новых переменных. Пароли — под `SECRETS_ENCRYPTION_KEY`.

## Документы

- **`docs/21-diagrams.md`** — ER: `outbound_proxy`, `outbound_service_mode`;
  в схеме клиента исходящих — перебор прокси.
- **`docs/29-admin-panel.md`** — строка раздела «Прокси».
- **`docs/30-configuration-map.md`** — прокси и режимы сервисов — панель,
  умолчания — `infra/outbound/outbound-route.ts`.

## Критерии приёмки

- [ ] Прокси заводятся, правятся и проверяются в панели; пароль не виден
  нигде.
- [ ] Сервис в режиме «сначала напрямую» при сетевом сбое, таймауте, 403
  или 451 проходит через прокси. Сработавший прокси первым пробуется 10
  минут.
- [ ] Каждая попытка видна в «Запросах» с прокси.
- [ ] Bot API по умолчанию — только напрямую.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Прокси для исходящих запросов`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОКСИ ДЛЯ ВНЕШНИХ API**

  Сервер может ходить к внешним API через прокси: список — в панели, раздел «Прокси». Если напрямую не достучаться — сеть, таймаут, отказ по стране, — запрос пробует прокси по порядку и запоминает, какой сработал. Каждая попытка видна в «Запросах».
  ```
