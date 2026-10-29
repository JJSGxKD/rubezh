---
id: T-0216
title: Уровни ролей — администратор выдаёт роли ниже своей
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0112, T-0144]
zones:
  - backend/api/src/modules/roles/roles.service.ts
  - backend/api/src/modules/roles/role-levels.ts
  - backend/api/src/modules/admin/admin-roles.service.ts
  - backend/api/test/roles.test.ts
  - backend/api/test/roles.integration.test.ts
  - apps/admin/src/api/roles.ts
  - apps/admin/src/screens/roles/RolesScreen.tsx
shared:
  - backend/api/src/modules/roles/permissions.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0216. Уровни ролей — администратор выдаёт роли ниже своей

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0216.json)](README.md#значки-статуса) [![T-0112](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0112.json&label=T-0112)](archive/T-0112-separate-board-restriction.md) [![T-0144](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0144.json&label=T-0144)](archive/T-0144-dev-login-as-player.md)

## Зачем

Сейчас роли в панели выдаёт только владелец. Партнёров (Р136) и помощников
станет больше, и каждую выдачу через владельца не провести. После задачи у
ролей есть уровни: администратор выдаёт и снимает роли ниже своей —
маркетолога, геймдизайнера, модератора, аналитика, а после T-0217 и
партнёра, — но не трогает владельца, других администраторов, финансы и
участников проекта.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р136: у ролей
появляются уровни; выдать можно только роль ниже своей; партнёра выдают
владелец и администратор; выдача и снятие — в журнале.

Решения `claude-lead-1` от 24.10.2026 (порядок ролей — по тому, что роль
открывает):

- **Уровни** (`role-levels.ts`):

  | Роль | Уровень | Почему |
  |---|---|---|
  | `owner` | 100 | всё |
  | `stakeholder`, `finance` | 90 | деньги и доли — только по решению владельца |
  | `admin` | 80 | операционка |
  | `game_designer`, `marketer` | 50 | контент, рассылки и ссылки |
  | `moderator` | 40 | игроки без платёжных данных |
  | `analyst` | 30 | только чтение |

  Роль `partner` и её уровень 20 добавит T-0217.
- **Правило.** Выдать или снять роль R у аккаунта T может тот, у кого есть
  `roles.assign`, если его наибольший уровень **выше** уровня R и выше
  наибольшего уровня T. Владелец выдаёт и снимает любые роли, как сейчас.
  Себе — по-прежнему нельзя (`ensureNotSelf`).
- **`roles.assign` получает `admin`.** Видеть список выданных ролей и
  искать кандидата он может целиком — это чтение; ограничено только
  изменение.
- **Отказ** — `ForbiddenError` «Эту роль может выдать только тот, у кого
  роль выше» и «У этого аккаунта роль не ниже вашей — менять её роли нельзя».
  Подтверждение выдачи в Telegram (`role-confirmations.ts`) проходит через
  тот же `grant` и отказывает так же.
- **Панель** — в ответе `GET /admin/roles` у каждой роли каталога флаг
  `grantable` для того, кто спрашивает; диалог выдачи предлагает только
  такие роли, крестик снятия — только у ролей, которые можно снять.

## Как сейчас

- `backend/api/src/modules/roles/permissions.ts:113–122` — `ROLES`;
  `ROLE_PERMISSIONS` (134–…): `roles.assign` есть только у `owner`.
- `backend/api/src/modules/roles/roles.service.ts:86–108` — `grant`, `revoke`,
  `assignments`: проверка права `roles.assign` и `ensureNotSelf`
  (168–172).
- `backend/api/src/modules/admin/admin-roles.service.ts` — ответ
  `RoleAssignments` для панели (каталог ролей и выданные).
- `backend/api/src/modules/admin/role-confirmations.ts:105–119` —
  подтверждение выдачи вызывает `roles.grant`.
- `apps/admin/src/screens/roles/RolesScreen.tsx` — список, `GrantDialog`
  (122–…), `RoleChip` со снятием (100–110).
- `backend/api/test/roles.test.ts` — тест матрицы прав: падает, если право
  есть у роли, которой его не отметили.

## Шаги по порядку

1. **`role-levels.ts`** — `ROLE_LEVELS: Record<Role, number>`,
   `levelOf(roles: Role[]): number` (0 — нет ролей), `canManage(actorRoles,
   targetRoles, role): boolean` — правило из «Решений».
2. **`permissions.ts`** — `roles.assign` в список `admin`.
3. **`roles.service.ts`** — `grant` и `revoke` после `require` проверяют
   `canManage` по ролям действующего и цели; отказ — `ForbiddenError` с
   текстами из «Решений».
4. **`admin-roles.service.ts`** — флаг `grantable` у ролей каталога для
   спрашивающего.
5. **Панель** — `api/roles.ts`: схема ответа с `grantable`;
   `RolesScreen.tsx`: в диалоге — только `grantable`, у чипа роли — снятие,
   только если её можно снять (уровень роли ниже и аккаунт ниже).
6. **`docs/29-admin-panel.md` §3.1** — абзац «Уровни ролей» с таблицей и
   правилом; в таблице ролей у `admin` — «выдаёт роли ниже своей».

## Чего не трогаем

- Роль `partner` и кабинет — T-0217.
- Состав прав ролей, кроме `roles.assign` у `admin`.
- Аварийный вход владельца по `ADMIN_TELEGRAM_IDS`.

## Сценарий и интерфейс

Администратор открывает «Роли», нажимает «Выдать», вводит Telegram ID — в
списке ролей только маркетолог, геймдизайнер, модератор и аналитик. У
владельца и другого администратора в списке нет крестиков снятия. Попытка
выдать роль запросом в обход панели — отказ с текстом из «Решений».

## Тесты

Первым коммитом.

- `roles.test.ts`:
  - `canManage`: админ выдаёт `analyst` игроку → да; админ выдаёт `admin`
    → нет; админ выдаёт `finance` → нет; админ снимает `analyst` у
    владельца → нет (аккаунт выше); владелец выдаёт `owner` → да;
    аналитик с `roles.assign` (такого нет, проверка функции) → нет для
    любой роли выше 30;
  - матрица прав: `roles.assign` у `owner` и `admin`, у остальных — нет.
- `roles.integration.test.ts` — на живой базе: администратор выдаёт
  маркетолога → роль есть, запись в журнале с ним как исполнителем;
  администратор выдаёт администратора → `ForbiddenError`, роли нет.
- Ручная проверка панели под администратором — снимок диалога выдачи в PR.

## Аналитика

Нет новых событий: выдача и снятие — в журнале аудита, как сейчас.

## Настройки и окружение

Нет.

## Документы

`docs/29-admin-panel.md` §3.1 — по шагу 6.

## Критерии приёмки

- [ ] Администратор выдаёт и снимает только роли ниже своей и только у
  аккаунтов ниже себя; владелец — любые.
- [ ] Обход панели запросом даёт тот же отказ.
- [ ] Панель не предлагает недоступных ролей.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(roles): Уровни ролей — администратор выдаёт роли ниже своей`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — УРОВНИ РОЛЕЙ**

  У ролей появились уровни. Администратор теперь сам выдаёт и снимает роли ниже своей — маркетолога, геймдизайнера, модератора, аналитика, — но не трогает владельца, других администраторов, финансы и участников проекта. Владелец по-прежнему выдаёт любые роли.
  ```
