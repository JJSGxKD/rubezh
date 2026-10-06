---
id: T-0021
title: Маршруты с правами — только в панели, дубли под токеном игры убраны
epic: E4
priority: P1
status: ready
owner:
size: S
depends_on: []
zones:
  - backend/api/src/modules/roles/roles.controller.ts
  - backend/api/src/modules/runs/runs.controller.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/wallet/wallet.controller.ts
  - backend/api/src/modules/wallet/dto/wallet.dto.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/fx/fx.controller.ts
  - backend/api/src/modules/fx/fx.module.ts
  - backend/api/test/route-permissions.test.ts
shared:
  - docs/29-admin-panel.md
  - docs/35-stage4-plan.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0021. Маршруты с правами — только в панели, дубли под токеном игры убраны

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0021.json)](README.md#значки-статуса)

## Зачем

Часть действий с правами доступна двумя путями:
- через панель (`/api/v1/admin/*`) под её cookie-сессией с коротким сроком;
- через старые маршруты под токеном доступа игры.

Старыми маршрутами не пользуется ни клиент, ни панель. Но это лишняя
поверхность: те же права работают по другому, более долгоживущему способу
входа. Задача убирает дубли и закрепляет правило тестом: маршрут, требующий
права, живёт только в панели.

## Решения

- **Убираем шесть маршрутов** — у каждого есть рабочий двойник в панели:

  | Убираем | Двойник в панели |
  |---|---|
  | `POST /roles/grant` | `POST /admin/roles/grant` (`admin-roles.controller.ts`) |
  | `POST /roles/revoke` | `POST /admin/roles/revoke` |
  | `GET /roles/audit` | `GET /admin/audit` |
  | `GET /runs/review` | `GET /admin/runs/review` (`admin-review.controller.ts`) |
  | `GET /wallet/admin`, `POST /wallet/admin/adjust` | `/admin/players/:accountId/…`, `POST /admin/players/:accountId/wallet/adjust` |
  | `GET /fx/admin`, `POST /fx/admin/manual` | `GET /admin/fx`, `POST /admin/fx/manual` |

- **Остаются** маршруты игрока без прав: `GET /roles/me`, `GET /tools/access`,
  `GET /wallet`, `GET /referrals` и все маршруты `runs`, кроме разбора. Лимиты
  частоты на часть из них ставит T-0022.
- **Сервисы не трогаем:** `RolesService.grant`/`revoke`, `RunsViewService.review`,
  `WalletService.adjust`, `FxService.overview`/`setManual` нужны панели.
  Уходят только контроллерные методы и то, что стало неиспользуемым рядом с
  ними: схемы DTO, лимиты, импорты.
- **Правило закрепляет тест:** маршрут с `@RequirePermission` — только в
  контроллере с путём `admin` или `admin/…`.
- **Ломающее изменение API не объявляем:** у маршрутов нет потребителей. Это
  проверено поиском по `packages/`, `apps/`, `scripts/` и `backend/api/test`.
  Аварийный доступ владельца идёт через `ADMIN_TELEGRAM_IDS` (`RolesService`),
  а не через `/roles/grant`.

## Как сейчас

- `backend/api/src/modules/roles/roles.controller.ts`:
  - строки 45–50 — `GET /roles/me`, остаётся;
  - строки 52–74 — `grant`, `revoke`, `audit`;
  - строки 76–88 — приватный `resolve`;
  - строки 23–34 — схемы `targetSchema` и `auditQuerySchema`;
  - ниже — функция `parse`;
  - строки 13–21 — комментарий класса: «через которую владелец раздаёт роли
    команде».
- `backend/api/src/modules/runs/runs.controller.ts:56-63` — `GET /runs/review`
  под `PermissionGuard` и `players.view`. Импорты `RequirePermission`,
  `PermissionGuard`, `reviewLimitSchema` (из `./dto/runs.dto.js`), тип
  `ReviewRow`. В комментарии к `:runId` (строки 65–68) упомянут `review`.
  У панели своя `reviewLimitSchema` в `modules/admin/dto/admin.dto.ts:104`.
- `backend/api/src/modules/wallet/wallet.controller.ts`:
  - строки 38–46 — `GET /wallet/admin`;
  - строки 48–66 — `POST /wallet/admin/adjust`;
  - приватный `resolve`, зависимость `ACCOUNT_REPOSITORY`, импорты
    `PermissionGuard` и `RequirePermission`;
  - комментарий класса «панели — чужой кошелёк…».

  Схемы `walletLookupSchema` и `walletAdjustSchema` с типами `WalletLookup` и
  `WalletAdjust` лежат в `dto/wallet.dto.ts:25-46`. У панели своя
  `adminWalletAdjustSchema`, а `WALLET_LIMITS.adjust` (`wallet-limits.ts:72`)
  используется только этим контроллером.
- `backend/api/src/modules/fx/fx.controller.ts` — весь контроллер состоит из
  двух маршрутов `admin*`. Регистрация — `fx.module.ts:17`, `controllers: [FxController]`.
  `manualRateSchema` из `fx/dto/fx.dto.ts` использует панель
  (`admin-fx.controller.ts:5`), она остаётся.
- `backend/api/test/route-permissions.test.ts` — права на маршрутах читаются
  из метаданных Nest. Функция `routesOf` (строки 39–56) знает имя контроллера,
  но не его путь.

## Шаги по порядку

1. Тест первым коммитом (раздел «Тесты»). На нынешнем коде он падает и
   называет восемь маршрутов.
2. **`roles.controller.ts`.** Оставить только `GET /roles/me`:
   - удалить `grant`, `revoke`, `audit`, `resolve`, `targetSchema`,
     `auditQuerySchema` и `parse`, если она больше не нужна;
   - удалить неиспользуемые импорты и зависимости конструктора
     (`ACCOUNT_REPOSITORY`, `ROLES_REPOSITORY`, `PermissionGuard`,
     `RequirePermission`, `ValidationError`, `z`, `ZodError`);
   - комментарий класса заменить на: «Свои роли и права — игроку и
     инструментам. Выдача ролей и журнал — только в панели
     (`admin-roles.controller.ts`): у неё своя сессия с коротким сроком
     (`docs/29-admin-panel.md` §3.4)».
3. **`runs.controller.ts`.** Удалить `review` и ставшие лишними импорты:
   `RequirePermission`, `PermissionGuard`, `reviewLimitSchema`, `ReviewRow`.
   В комментарии к `detail` убрать `review` из списка. В `dto/runs.dto.ts`
   удалить `reviewLimitSchema`, если ею больше никто не пользуется (`rg -n reviewLimitSchema backend/api`).
4. **`wallet.controller.ts`.** Оставить только `GET /wallet`. Удалить
   `inspect`, `adjust` и `resolve`, зависимость `ACCOUNT_REPOSITORY` и
   ставшие лишними импорты. Комментарий класса: «Кошелёк игрока — только
   чтение своего. Чужой кошелёк и ручные операции — в панели
   (`admin-players.controller.ts`)».
   - `dto/wallet.dto.ts`: удалить `walletLookupSchema`, `walletAdjustSchema`,
     `WalletLookup` и `WalletAdjust`, а также `targetShape` и `hasTarget`, если
     их больше никто не использует.
   - `wallet-limits.ts`: убрать `adjust` из `WALLET_LIMITS`, тип —
     `Record<"read", RateLimit>`. Комментарий над ним: «Кошелёк читают шапка и
     экран итогов — единицы в минуту».
5. **`fx.controller.ts`** удалить целиком. В `fx.module.ts` убрать импорт и
   `controllers: [FxController]`. Если массив стал пустым — убрать ключ.
6. **Проверка поиском:** `rg -n "roles/grant|roles/revoke|roles/audit|runs/review|wallet/admin|fx/admin" backend/api/src`
   находит только маршруты и комментарии панели (`admin/…`).
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Контроллеры панели `modules/admin/*` и их схемы.
- Сервисы и репозитории ролей, забегов, кошелька и курсов.
- `GET /roles/me`, `GET /tools/access`, `GET /referrals`, `GET /wallet` и
  лимиты на них: лимиты — T-0022.
- `scripts/` и CLI (`wallet:reconcile`, `fx:manual`): они идут мимо HTTP.

## Тесты

Первым коммитом, `backend/api/test/route-permissions.test.ts`:

- в `RouteInfo` — новое поле `path: string`, путь контроллера из
  `Reflect.getMetadata("path", controller)`; если его нет — пустая строка;
- новый кейс «маршрут с правом — только в панели: путь контроллера `admin` или
  `admin/…`». Все маршруты с `PERMISSION_METADATA`, у которых путь не `admin`
  и не начинается с `admin/`, собираются в `Контроллер.метод`. Ожидание —
  пустой список, сообщение: «право — только в панели: перенесите маршрут в
  `modules/admin` или уберите право». На нынешнем коде падает и называет
  `FxController.overview`, `FxController.setManual`, `RolesController.grant`,
  `RolesController.revoke`, `RolesController.audit`, `RunsController.review`,
  `WalletController.inspect`, `WalletController.adjust`;
- существующие кейсы файла остаются зелёными.

Других тестов эти маршруты не вызывают: `backend/api/test` проверен поиском.

## Аналитика

Нет: маршрутов без потребителей не стало, действий игрока это не меняет.

## Настройки и окружение

Нет. Из `WALLET_LIMITS` уходит `adjust`.

## Документы

- `docs/29-admin-panel.md` §3.4 «Правила», после пункта «Закрыто по
  умолчанию» — новый пункт: «**Права — только в панели.** Маршрут, который
  требует права, живёт в `modules/admin` под путём `/api/v1/admin` и сессией
  панели. Под токеном доступа игры прав нет: дубли сняты в T-0021, правило
  держит `backend/api/test/route-permissions.test.ts`».
- `docs/35-stage4-plan.md`:
  - строки 1113–1115: «панели — `GET /api/v1/wallet/admin` … и
    `POST /api/v1/wallet/admin/adjust`» → «панели — карточка игрока и
    `POST /api/v1/admin/players/:accountId/wallet/adjust`». Остальное
    предложение не меняется;
  - строки 1674 и 1678: `POST /api/v1/fx/admin/manual` → `POST /api/v1/admin/fx/manual`,
    `GET /api/v1/fx/admin` → `GET /api/v1/admin/fx`;
  - строка 1727: `POST /api/v1/fx/admin/manual` → `POST /api/v1/admin/fx/manual`.
- `docs/30-configuration-map.md`, строка 172 «Кошелёк: …лимиты частоты чтения и
  ручных операций» → «…лимит частоты чтения»: ручные операции теперь только в
  панели, со своим лимитом.

## Критерии приёмки

- [ ] Шести маршрутов из таблицы «Решения» больше нет. На запрос к ним сервер
  отвечает 404.
- [ ] Новый тест прав падал на старом коде и зелёный на новом.
- [ ] Панель работает как раньше: роли, журнал, разбор, кошелёк игрока,
  курсы. Её маршрутов дифф не касается.
- [ ] Неиспользуемых схем, лимитов и импортов после удаления не осталось
  (`pnpm lint`, `pnpm typecheck`).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(api): Убрать маршруты с правами вне панели`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРАВА ТОЛЬКО В ПАНЕЛИ**

  Действия с правами — выдача ролей, журнал, разбор забегов, чужой кошелёк, курсы — теперь доступны только через панель с её короткой сессией. Старые дубли этих маршрутов под токеном игры убраны: ими никто не пользовался.

  🔒 **Что изменилось**

  • убраны /roles/grant, /roles/revoke, /roles/audit, /runs/review, /wallet/admin*, /fx/admin*
  • тест следит, чтобы маршрут с правом жил только под /admin
  ```
