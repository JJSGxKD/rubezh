---
id: T-0452
title: Доли участников проекта — сервер
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/stakeholders/**
  - backend/api/src/modules/admin/admin-stakeholders.controller.ts
  - backend/api/prisma/migrations/
  - backend/api/test/stakeholder-shares.test.ts
  - backend/api/test/stakeholder-shares.integration.test.ts
  - backend/api/test/admin-stakeholders.http.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/app.module.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/test/roles.test.ts
  - backend/api/test/route-permissions.test.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0452. Доли участников проекта — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0452.json)](../README.md#значки-статуса)

## Зачем

Сейчас у роли «Участник проекта» (`stakeholder`) есть только право
`revenue.split.own.view`, а за ним ничего нет: доли участников нигде не
хранятся, распределение дохода по `docs/11-revenue-split.md` §3 (шаг 5) не на
чем считать. Задача заводит доли: владелец назначает участнику процент с
нужного месяца, история не теряется, сумма долей не уходит за 100 %. На этих
долях строятся кабинет участника (T-0453, T-0455) и позже — водопад закрытого
месяца.

## Решения

- `docs/35-stage4-plan.md`, **Р217** (ответ владельца 13.11.2026):
  - доля — у аккаунта с ролью участника, процент с двумя знаками, хранится
    целым числом сотых долей процента — **базисными пунктами** (`share_bp`,
    0…10 000);
  - действует с первого числа выбранного месяца по UTC; история не правится:
    новая доля — новая запись; запись на тот же месяц заменяет прежнюю;
    конец участия — запись 0 %;
  - месяц начала — не раньше текущего месяца по UTC;
  - сумма долей всех участников на любой месяц ≤ 10 000 б. п.; остаток —
    доля владельца;
  - менять — новое право `stakeholders.manage`, только у владельца; причина
    обязательна; изменение — в аудит `stakeholders.share.set`;
  - долю больше нуля можно назначить только аккаунту с ролью `stakeholder`;
    снятие роли доли не стирает, а в ответе стоит `hasRole: false`;
  - участник видит всех участников с долями.

## Как сейчас

- Роли и права: `backend/api/src/modules/roles/permissions.ts` — список
  `PERMISSIONS`, наборы ролей (строка ~153 `owner: PERMISSIONS`, ~244
  `stakeholder: ["revenue.split.own.view"]`, у `finance` —
  `revenue.split.view`).
- Проверка прав в сервисе — `RolesService.can(account, permission)`
  (`roles.service.ts`, строка ~63); роли аккаунта —
  `RolesRepository.rolesOf(accountId)`.
- Аудит — `RolesService.audit({ actorAccountId, action, target, before, after })`
  (пример — `admin/admin-secrets.service.ts`, строка ~84), таблица
  `audit_entry`.
- Образец маршрута, где право проверяет сервис, а не охранник («или одно, или
  другое право»), — `admin/admin-cabinet.controller.ts` и `PartnerCabinet`.
- Имя аккаунта для панели — `Account.displayName`.
- Глобальный префикс API — `api/v1` (`http-app.ts`): маршрут контроллера
  `admin/stakeholders` → `/api/v1/admin/stakeholders`.

## Шаги по порядку

1. **Схема** (`schema.prisma`), новая модель и миграция
   `<время>_stakeholder_share` (только расширение):

   ```prisma
   /// Доля участника проекта с месяца (Р217): новая доля — новая строка, конец участия — 0.
   model StakeholderShare {
     shareId    String   @id @map("share_id") @db.Uuid
     accountId  String   @map("account_id") @db.Uuid
     /// первое число месяца по UTC, с которого действует доля
     fromMonth  DateTime @map("from_month") @db.Date
     /// сотые доли процента: 2 550 — 25,5 %
     shareBp    Int      @map("share_bp")
     note       String   @db.VarChar(500)
     setBy      String   @map("set_by") @db.Uuid
     setAt      DateTime @default(now()) @map("set_at") @db.Timestamptz(3)

     account Account @relation("StakeholderShares", fields: [accountId], references: [accountId], onDelete: Restrict)
     setter  Account @relation("StakeholderSharesSet", fields: [setBy], references: [accountId], onDelete: Restrict)

     @@unique([accountId, fromMonth])
     @@index([fromMonth])
     @@map("stakeholder_share")
   }
   ```

   В миграции — `CHECK (share_bp BETWEEN 0 AND 10000)` и
   `CHECK (extract(day from from_month) = 1)`. Обратные связи у `Account`.
2. **Ядро правил** — `modules/stakeholders/stakeholder-rules.ts`, чистые
   функции без Nest и Prisma:
   - `monthKey(date): string` — `"YYYY-MM"` по UTC; `parseMonth("YYYY-MM"): Date`
     — первое число месяца 00:00 UTC, неверная строка — исключение;
   - `shareAt(history, month): number` — доля в б. п. на месяц: последняя
     запись с `fromMonth ≤ month`, нет такой — 0;
   - `overLimit(all, change): { month: string; totalBp: number } | null` —
     применяет изменение (замена записи того же аккаунта и месяца или новая)
     и проверяет сумму на каждом месяце-границе от `change.fromMonth` до
     последней записи любого участника включительно; первая граница с суммой
     больше 10 000 — ответ, иначе `null`;
   - `percentToBp(value: number): number` — проценты с двумя знаками в б. п.
     без ошибок плавающей точки (`Math.round(value * 100)`, проверка, что
     `bp / 100` даёт исходное число до сотых), вне 0…100 — исключение.
3. **Репозиторий** `modules/stakeholders/stakeholders.repository.ts`
   (Prisma только здесь):
   - `history(): Promise<StoredShare[]>` — все строки с именами аккаунтов и
     того, кто менял;
   - `participants(): Promise<ParticipantRow[]>` — аккаунты с ролью
     `stakeholder` **или** хотя бы одной строкой доли: `accountId`,
     `displayName`, `hasRole`;
   - `setShare(input, check)` — в одной транзакции: `pg_advisory_xact_lock`
     по постоянному ключу таблицы долей, чтение всех строк, вызов `check`
     (функция `overLimit` из шага 2) и `upsert` по
     `(account_id, from_month)`. Возвращает было/стало. Блокировка нужна,
     потому что две вкладки владельца иначе могут вместе превысить 100 %.
4. **Сервис** `modules/stakeholders/stakeholders.service.ts`:
   - `list(actor, now)` — право `revenue.split.view` **или**
     `revenue.split.own.view`, иначе `ForbiddenError` из
     `common/domain-error.ts` (как у кабинета партнёра, `partner-cabinet.ts`). Ответ:

     ```ts
     interface StakeholdersView {
       month: string; // текущий, "YYYY-MM"
       participants: {
         accountId: string;
         name: string;
         hasRole: boolean;
         current: { sharePercent: number; fromMonth: string } | null; // доля на текущий месяц; 0 % — null
         next: { sharePercent: number; fromMonth: string } | null;    // ближайшая будущая запись, если есть
         history: { sharePercent: number; fromMonth: string; note: string; setBy: string; setAt: string }[]; // новые сверху
       }[];
       ownerSharePercent: number; // 100 − сумма долей на текущий месяц
     }
     ```

     Участнику (только `revenue.split.own.view`) поле `note` и `setBy`
     в истории **не отдаётся**: причины — внутренние записи владельца.
   - `setShare(actor, accountId, { sharePercent, fromMonth, note }, now)` —
     право `stakeholders.manage`; месяц раньше текущего —
     `StakeholderMonthPastError` (400, `stakeholder_month_past`); доля > 0 у
     аккаунта без роли — `StakeholderRoleRequiredError` (409,
     `stakeholder_role_required`); превышение — `StakeholderSharesOverError`
     (409, `stakeholder_shares_over`, в тексте месяц и сумма); аккаунта нет —
     404. Затем аудит `stakeholders.share.set`, `target` — `accountId`,
     `before`/`after` — `{ fromMonth, sharePercent }` (до — `null`, если
     записи на этот месяц не было).
5. **Права** (`permissions.ts`): новое `stakeholders.manage` в `PERMISSIONS`
   рядом с бухгалтерией; в наборы ролей не добавлять — у владельца оно есть
   через `PERMISSIONS`. Описание права для панели — в том же файле, где
   описаны остальные (если описаний там нет — не заводить).
6. **Контроллер** `admin/admin-stakeholders.controller.ts`,
   `@Controller("admin/stakeholders")`, охранник сессии; права проверяет
   сервис (шаг 4):
   - `GET /` → `{ data: StakeholdersView }`;
   - `PUT /:accountId/share` — тело Zod:
     `{ sharePercent: z.number().min(0).max(100), fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), note: z.string().trim().min(3).max(500) }`,
     `.strict()`; ответ — обновлённый `StakeholdersView`. Повтор того же
     запроса безопасен: запись на месяц заменяется тем же значением.
   - Модуль `StakeholdersModule` подключить в `app.module.ts`, контроллер —
     в `admin.module.ts`; `route-permissions.test.ts` — маршруты под
     охранником сессии.
7. **Тексты ошибок** — на русском, без повелительного к игроку (это панель,
   но `player-address.test.ts` смотрит и сюда — проверить):
   - `stakeholder_month_past`: «Долю можно поменять только с текущего месяца
     или позже: прошлые месяцы не пересчитываются»;
   - `stakeholder_role_required`: «У аккаунта нет роли «Участник проекта» —
     долю больше нуля назначить нельзя»;
   - `stakeholder_shares_over`: «С {месяц} доли участников в сумме дали бы
     {N} % — больше 100 %».
8. **Документы**: `docs/21-diagrams.md` — ER-диаграмма: таблица
   `stakeholder_share` и связи с `account`; `docs/29-admin-panel.md` §3 —
   строка права `stakeholders.manage` в таблице прав, если права там
   перечислены.

## Чего не трогаем

- Экран панели — T-0454; кабинет и выручку — T-0453, T-0455.
- Роли `finance` и `stakeholder` — их наборы прав не меняются.
- Снятие роли (`roles` модуль) — доли при этом не трогаются и не
  проверяются.
- Ядро учёта, периоды, проводки (`docs/37-accounting.md`) — следующие волны.

## Сценарий и интерфейс

- Владелец: `PUT /admin/stakeholders/<id>/share`
  `{ "sharePercent": 25.5, "fromMonth": "2026-12", "note": "договорённость от 13.11" }`
  → в списке у участника `next: { sharePercent: 25.5, fromMonth: "2026-12" }`.
- Участник открывает `GET /admin/stakeholders` и видит всех участников с
  долями, без причин.

## Тесты

Первым коммитом:

- `backend/api/test/stakeholder-shares.test.ts` (ядро правил):
  - `shareAt`: нет записей — 0; запись в будущем — 0 на текущий месяц; две
    записи — берётся последняя не позже месяца;
  - `overLimit`: двое по 50 % — `null`; третий с 1 % с того же месяца —
    `{ month, totalBp: 10100 }`; будущая запись одного участника снижает долю
    — превышение только до неё; замена записи того же месяца не считается
    дважды;
  - `percentToBp`: 25.5 → 2550, 33.33 → 3333, 0.1 + 0.2 → 30, 100.001 —
    исключение, −1 — исключение;
  - `parseMonth`: «2026-13», «2026-1», «abc» — исключение.
- `backend/api/test/stakeholder-shares.integration.test.ts` (настоящий
  Postgres, `test-env.sh`):
  - назначение и замена записи того же месяца: одна строка, аудит с
    было/стало;
  - две параллельные записи по 60 % двум участникам — одна проходит, вторая
    `stakeholder_shares_over`;
  - доля > 0 аккаунту без роли — `stakeholder_role_required`; 0 % такому —
    проходит;
  - месяц раньше текущего — `stakeholder_month_past`.
- `backend/api/test/admin-stakeholders.http.test.ts`:
  - без сессии — 401; участник видит список без `note`/`setBy`; финансы —
    с причинами; участник и финансы на `PUT` — 403; владелец — 200;
  - тело с лишним полем или долей 101 — 400.

## Аналитика

Нет событий: доли — решения владельца, их след — аудит
(`stakeholders.share.set`), а не продуктовая аналитика.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md` — ER-диаграмма (шаг 8).
- `docs/29-admin-panel.md` — право `stakeholders.manage` (шаг 8).

## Критерии приёмки

- [ ] Владелец назначает долю с месяца; запись того же месяца заменяется,
      история не теряется, изменение видно в аудите.
- [ ] Сумма долей больше 100 % ни на одном месяце не сохраняется, в том
      числе при параллельных запросах.
- [ ] Участник видит всех участников с долями и без причин; финансы — с
      причинами; менять может только владелец.
- [ ] Миграция только расширяет схему, ER-диаграмма обновлена.
- [ ] Тесты из раздела «Тесты» есть и зелёные; гейт и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(finance): Доли участников проекта — сервер`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОЛИ УЧАСТНИКОВ ПРОЕКТА**

  Первая волна бухгалтерии (Р217): сервер хранит доли участников проекта с
  месяца, с историей; сумма долей не больше 100 %, остаток — доля владельца.

  🛠 **Что внутри**

  • таблица stakeholder_share: доля с месяца, причина, кто поменял
  • менять — только владелец (право stakeholders.manage), каждое изменение в аудите
  • участник видит всех участников с долями — экран в T-0454, кабинет в T-0455
  ```
