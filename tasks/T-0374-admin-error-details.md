---
id: T-0374
title: Ошибки запросов в панели — код, статус, номер запроса и причина внутренней ошибки по праву
epic: E7
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/common/domain-error.filter.ts
  - backend/api/src/http-app.ts
  - backend/api/src/modules/roles/permission.guard.ts
  - backend/api/src/modules/roles/roles.service.ts
  - backend/api/test/domain-error.filter.test.ts
  - backend/api/test/http-app.test.ts
  - backend/api/test/admin-error-details.test.ts
  - apps/admin/src/api/client.ts
  - apps/admin/src/ui/toast.tsx
  - apps/admin/src/ui/kit.tsx
  - apps/admin/test/client.test.ts
  - apps/admin/test/error-details.test.ts
shared:
  - apps/admin/src/screens/ads/BlockDialog.tsx
  - apps/admin/src/screens/ads/NetworkCards.tsx
  - apps/admin/src/screens/fx/FxScreen.tsx
  - apps/admin/src/screens/links/LinkCard.tsx
  - apps/admin/src/screens/names/NamesScreen.tsx
  - apps/admin/src/screens/names/RecleanPanel.tsx
  - apps/admin/src/screens/partners/PartnerDialog.tsx
  - apps/admin/src/screens/partners/PartnerStatusDialog.tsx
  - apps/admin/src/screens/players/PlayerHeader.tsx
  - apps/admin/src/screens/promo-codes/PromoCodeCard.tsx
  - apps/admin/src/screens/promo-codes/PromoCodeDialog.tsx
  - apps/admin/src/screens/promo-codes/PromoCodesScreen.tsx
  - apps/admin/src/screens/proxies/ModesPanel.tsx
  - apps/admin/src/screens/proxies/ProxiesScreen.tsx
  - apps/admin/src/screens/proxies/ProxyDialog.tsx
  - apps/admin/src/screens/proxies/SubscriptionDialog.tsx
  - apps/admin/src/screens/proxies/SubscriptionPanel.tsx
  - apps/admin/src/screens/roles/RolesScreen.tsx
  - apps/admin/src/screens/secrets/SecretsScreen.tsx
  - apps/admin/src/screens/tasks/NetworkTasksPanel.tsx
  - docs/15-engineering-standards.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 4
---

# T-0374. Ошибки запросов в панели — код, статус, номер запроса и причина внутренней ошибки по праву

## Зачем

Когда запрос панели падает, команда видит текст вроде «Внутренняя ошибка
сервера» или «Некорректный запрос» и не понимает, что случилось и где искать
(владелец, 04.11.2026). После задачи у каждой ошибки в панели есть строка «код ·
статус · номер запроса» с кнопкой «Скопировать»: по номеру запись находится в
логе API. Тот, у кого есть техническое право, на внутренней ошибке админского
маршрута сразу видит её причину.

## Решения

Р193 (`docs/35-stage4-plan.md`, 04.11.2026):

- **Каждая ошибка в панели** показывает текст сервера и строку
  `код · статус · №<номер запроса>` с кнопкой «Скопировать». По номеру запроса
  ошибка находится в логе API.
- **Причина** — текст исключения, без стека. Сервер отдаёт её только на
  **админских маршрутах** (`/api/v1/admin/*`), только аккаунту с правом
  `diagnostics.view` и только для ошибок, у которых сейчас общий текст:
  внутренняя (500) и ошибки фреймворка (`HttpException`, ошибки разбора тела
  Fastify). У доменных ошибок (`DomainError`) текст уже человеческий, причины
  у них нет.
- **Игровые маршруты и остальные аккаунты** — как сейчас: «Внутренняя ошибка
  сервера» без причины. Номер запроса получают все: он ничего не раскрывает.

Уточнения `claude-lead-1` (по Р193, без нового продуктового выбора):

- **Номер запроса — случайный UUID**, его выдаёт сервер на каждый запрос.
  Заголовок `x-request-id` от клиента не принимается: номер в логе не должен
  задаваться снаружи.
- **Право проверяется без похода в базу на пути ошибки.** Охранник прав уже
  читает роли аккаунта, когда пускает его на маршрут. Он кладёт множество прав
  в запрос, а фильтр ошибок читает его оттуда. Если база упала до охранника,
  прав в запросе нет, и причина не отдаётся. Это безопасная сторона.
- **Причина обрезается** до 300 знаков, первая строка сообщения. Стек и
  многострочные хвосты остаются только в логе.

## Как сейчас

- **Фильтр.** `backend/api/src/common/domain-error.filter.ts`, 96 строк. В
  `DomainErrorFilter.catch` → `errorBodyFor(exception)`: `DomainError` отдаётся
  как есть. `HttpException` и ошибки Fastify со `statusCode` 4xx получают общий
  текст `describeStatus(status)`, подробность уходит в `logger.warn`.
  Остальное — `500 internal_error` «Внутренняя ошибка сервера», стек в
  `logger.error("Необработанная ошибка", …)`. Номера запроса нет ни в ответе, ни
  в логе. Тест — `backend/api/test/domain-error.filter.test.ts`.
- **Подключение.** `backend/api/src/http-app.ts`: `new FastifyAdapter({ bodyLimit,
  trustProxy })` — без `genReqId`, поэтому у Fastify номера вида `req-1`, они
  повторяются после перезапуска. Фильтр подключён
  `app.useGlobalFilters(new DomainErrorFilter())`, без DI. Хуки `onSend` и
  `onResponse` уже есть (~93, ~113, ~132). Тест — `backend/api/test/http-app.test.ts`.
- **Права.** `backend/api/src/modules/roles/permission.guard.ts` вызывает
  `roles.require(accountOf(request), permission)`. `RolesService.can`
  (`roles.service.ts:58`) — `permissionsOf(await this.rolesFor(account)).has(permission)`.
  Множество прав аккаунта считается, но не сохраняется. Право
  `diagnostics.view` есть в каталоге (`modules/roles/permissions.ts`).
- **Клиент панели.** `apps/admin/src/api/client.ts`:
  - `ApiError { kind, status, code, message }` (~43);
  - `errorEnvelope = z.object({ error: z.object({ code, message }) })` (~78) — лишние поля
    Zod отбрасывает;
  - `FALLBACK_MESSAGES` (~67) — свои тексты, когда конверта нет.
- **Показ ошибок.**
  - `ErrorNotice` (`apps/admin/src/ui/kit.tsx:238`) показывает только
    `error.message`.
  - Тосты — `toast.error(result.error.message)` примерно в 30 местах 20 экранов
    (список — `shared` в шапке).
  - `toast` — sonner, обёртка `apps/admin/src/ui/toast.tsx`, у тоста есть
    `description` и `action`.
- **Клиент игры.** Свои схемы ошибки (`packages/app-shell/src/state/auth-api.ts:114`,
  `api-request.ts:44`) — `z.object`, лишние поля отбрасываются. Игре задача ничего
  не меняет.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Номер запроса — `http-app.ts`:**
   - в `FastifyAdapter` добавить `genReqId: () => randomUUID()` (`node:crypto`) и
     `requestIdHeader: false`;
   - хук `onSend` (рядом с существующим) ставит заголовок ответа
     `x-request-id: <request.id>` на каждый ответ, в том числе с ошибкой.
3. **Права в запросе — `roles.service.ts` и `permission.guard.ts`:**
   - `RolesService.permissions(account): Promise<ReadonlySet<Permission>>` — то же,
     что считает `can`; `can` выражается через неё, поведение не меняется;
   - `PermissionGuard` берёт множество, проверяет право как раньше (та же
     `ForbiddenError("Недостаточно прав")`) и кладёт множество в
     `request.adminPermissions`. Тип поля объявляется рядом с полем `account`,
     как его объявляет `admin-session.guard.ts`.
4. **Фильтр — `domain-error.filter.ts`:**
   - `errorBodyFor(exception, context)`, где
     `context: { requestId: string | null; path: string; permissions: ReadonlySet<string> | null }` —
     чистая функция, её проверяют тесты. `catch` собирает `context` из
     `host.switchToHttp().getRequest()`: `request.id`, `request.url`,
     `request.adminPermissions`;
   - тело ошибки: `{ error: { code, message, requestId, reason? } }`. `requestId`
     есть всегда, когда номер известен;
   - `reason` — только если **все три условия**: путь начинается с `/api/v1/admin/`, в
     `permissions` есть `diagnostics.view`, ошибка — 500 или ветка
     `HttpException` / 4xx Fastify. Значение — первая строка `exception.message`,
     не длиннее 300 знаков, без стека. У `DomainError` поля `reason` нет никогда;
   - во всех строках лога фильтра — `requestId=<номер>`: поиск по логу находит
     запись по номеру из панели.
5. **Клиент панели — `client.ts`:**
   - `ApiError` получает `requestId: string | null` и `reason: string | null`;
   - конверт разбирает необязательные `requestId` и `reason` (строки, `reason` —
     не длиннее 300 знаков, иначе отбрасывается);
   - если в конверте номера нет, клиент берёт заголовок ответа `x-request-id`;
   - у заготовок `FALLBACK_MESSAGES` (ответа или конверта нет) номер берётся из
     заголовка, если ответ был; иначе `null`.
6. **Строка подробностей — `kit.tsx` и `toast.tsx`:**
   - чистая функция `errorDetails(error: ApiError): string | null` в `client.ts`.
     Собирает строку `код · статус · №номер` из тех частей, что есть, например
     `internal_error · 500 · №3f2a…`. Номер — первые 8 знаков, при копировании —
     целиком. Если нет ни кода, ни статуса, ни номера — `null`;
   - `ErrorNotice`: под текстом ошибки — `reason` (если есть) и строка
     подробностей мелким шрифтом, рядом кнопка «Скопировать». Копируется
     целиком: текст, причина, код, статус, полный номер, время по UTC;
   - `toastError(error: ApiError)` в `toast.tsx`: `toast.error(error.message, {
     description: <причина и строка подробностей>, action: { label:
     "Скопировать", … } })`. Тосты с ошибкой держатся 12 секунд, а не 6: строку
     успевают скопировать.
7. **Вызовы — экраны из `shared`:** каждый `toast.error(<x>.error.message)`
   заменить на `toastError(<x>.error)`. Это механическая замена по одной строке на
   место. Тосты не о запросах («Не удалось скопировать», «Браузер не дал
   скопировать…») не трогаются.
8. **Документы** — раздел «Документы».

## Чего не трогаем

- **Игровой клиент** (`packages/app-shell`): игроку причина и номер не
  показываются. Схемы ошибки в игре не меняются.
- **Тексты доменных ошибок** и коды `admin-errors.ts`.
- **Формат успешного ответа** `{ data }`.
- **Логирование** сверх строк фильтра: общий формат логов и формат доступа —
  отдельная тема эксплуатации.
- **`FALLBACK_MESSAGES`:** тексты остаются прежними, добавляется только номер.

## Сценарий и интерфейс

Любой экран панели, действие падает:

- **Тост:**
  - заголовок — текст сервера, как сейчас;
  - ниже серым — причина (если есть) и строка `код · статус · №номер`;
  - кнопка «Скопировать», после копирования — тост «Скопировано»;
  - буфер недоступен — «Браузер не дал скопировать — выделите вручную».
- **Плашка `ErrorNotice`** (загрузка раздела не удалась) — то же под текстом, рядом
  с «Повторить».
- **Нет связи** (`offline`): кода и статуса нет. Строка подробностей не
  показывается, если номера тоже нет.
- **У аккаунта нет `diagnostics.view`:** причины нет. Номер есть, его можно
  передать тому, у кого доступ к логам.

Строка подробностей — моноширинная, переносится (`break-all`). На 390 px не даёт
боковой прокрутки.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/domain-error.filter.test.ts` (`errorBodyFor` с контекстом):
  - `DomainError` → тело с `requestId`, без `reason` — и для админского пути с
    `diagnostics.view` тоже;
  - необработанная ошибка `new Error("db is down\n    at …")`:
    - путь `/api/v1/admin/proxies`, права `{diagnostics.view}` →
      `reason: "db is down"`, стека нет;
    - те же права и путь `/api/v1/runs` → без `reason`;
    - админский путь без права → без `reason`;
    - права `null` → без `reason`;
  - сообщение длиннее 300 знаков → `reason` ровно 300 знаков;
  - `HttpException` 400 на админском пути с правом → общий `message` прежний,
    `reason` — текст исключения;
  - ошибка Fastify 413 → так же;
  - `requestId: null` в контексте → поля `requestId` в теле нет или `null`
    (выбрать одно и проверить).
- `backend/api/test/http-app.test.ts`:
  - ответ на любой маршрут несёт `x-request-id` в формате UUID;
  - у двух запросов номера разные;
  - заголовок `x-request-id` в запросе не меняет номер ответа;
  - 500 на тестовом маршруте → `error.requestId` совпадает с заголовком.
- `backend/api/test/admin-error-details.test.ts` (Nest на подменах, как соседние
  `*.http.test.ts`):
  - админский маршрут, бросающий `Error`:
    - аккаунт с `diagnostics.view` → `reason`;
    - аккаунт без него (роль, у которой его нет) → нет `reason`;
  - у `PermissionGuard` при отказе (403) поведение прежнее.
- `apps/admin/test/client.test.ts`:
  - конверт с `requestId` и `reason` → поля в `ApiError`;
  - конверт без `requestId`, но с заголовком → номер из заголовка;
  - `reason` длиннее 300 → `null`;
  - 5xx без конверта → прежний текст и номер из заголовка.
- `apps/admin/test/error-details.test.ts`:
  - `errorDetails` → `internal_error · 500 · №3f2a1b4c` для полного набора;
  - без номера → `bad_request · 400`;
  - `offline` без всего → `null`;
  - копируемый текст содержит полный номер.

## Аналитика

Нет: это диагностика панели, а не действие игрока.

## Настройки и окружение

Нет. Право `diagnostics.view` уже есть в каталоге ролей.

## Документы

- `docs/15-engineering-standards.md`, §3 (формат ошибки) — поля `requestId` и
  `reason` (когда и кому), заголовок `x-request-id`.
- `docs/29-admin-panel.md`, раздел про подтверждения и тосты (~311-322) —
  строка подробностей, «Скопировать», причина по праву.

## Критерии приёмки

- [ ] В каждой ошибке панели — текст сервера и строка `код · статус · №номер` с
  «Скопировать».
- [ ] Номер ошибки из панели находится в логе API.
- [ ] Причина внутренней ошибки видна только на админских маршрутах и только с
  `diagnostics.view`.
- [ ] Игровые маршруты по-прежнему отдают «Внутренняя ошибка сервера» без
  причины.
- [ ] Номер запроса выдаёт сервер, заголовок клиента его не задаёт.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-лист
  безопасности `docs/15` §7 по пунктам «ошибки не раскрывают устройство» и
  «доступ».

## PR

- **Заголовок:** `feat(admin): Код, номер запроса и причина в ошибках панели`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОШИБКИ В ПАНЕЛИ: КОД, НОМЕР ЗАПРОСА И ПРИЧИНА**

  У каждой ошибки в панели теперь есть строка «код · статус · номер запроса» и кнопка «Скопировать»: по номеру запись находится в логе API. Если у вас есть право «Диагностика», на внутренней ошибке панель сразу показывает её причину.

  🛠 **Что внутри**

  • номер запроса выдаёт сервер на каждый запрос, он же в заголовке ответа и в логе
  • причина — только на маршрутах панели и только с правом diagnostics.view; игре ничего не меняется
  • тосты с ошибкой висят дольше — успеть скопировать
  ```
