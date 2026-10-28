---
id: T-0210
title: Уведомления гаснут своим действием — друзья, подарки, предмет, журнал
epic: E5
priority: P1
status: in-progress
owner: claude-1 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/notifications/notifications.repository.ts
  - backend/api/src/modules/notifications/notifications.service.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/items/items.service.ts
  - backend/api/src/modules/changelog/changelog.service.ts
  - backend/api/test/helpers/memory-notifications.ts
  - backend/api/test/notifications.integration.test.ts
  - backend/api/test/friends.test.ts
  - backend/api/test/items.integration.test.ts
  - backend/api/test/changelog.test.ts
  - backend/api/test/changelog.integration.test.ts
shared:
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0210. Уведомления гаснут своим действием — друзья, подарки, предмет, журнал

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0210.json)](README.md#значки-статуса)

## Зачем

Сейчас уведомление становится прочитанным, только когда игрок открыл ленту.
Он принял заявку в друзья с экрана друзей, забрал подарок, посмотрел
редкий предмет — а колокольчик всё горит про то, что уже сделано. После
задачи сервер гасит уведомление там, где игрок сделал то, о чём оно.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р135 (вопросы
Г1–Г4):

- **Заявка в друзья** (`friend_request`) гаснет при открытии экрана друзей
  (все непрочитанные заявки аккаунта) и при ответе на заявку — принять или
  отклонить (заявки от этого игрока).
- **Подарок друга** (`friend_gift`) гаснет, когда подарок забрали: у
  уведомлений от тех друзей, чьи подарки этим забором забраны.
- **Редкая добыча** (`rare_loot`) гаснет, когда лист предмета открыт:
  уведомления с `itemId` из списка просмотренных.
- **Выход версии** (`app_update`) гаснет, когда открыт журнал обновлений:
  все непрочитанные `app_update` аккаунта.
- **«Бусты вернулись» и «сообщение команды»** — только лентой, как сейчас.
- **Гасит сервер**, после успешного действия, тем же запросом.
- **Знак друзей не меняется**: он считает то, что ждёт действия, и гаснет
  только действием (`FriendsService.badge`). Колокольчик — непрочитанное.

Решения `claude-lead-1` от 24.10.2026:

- **Отдельной транзакции с действием нет.** Отметка — следующим запросом
  после успешного действия; сбой отметки не отменяет действие и не роняет
  ответ: предупреждение в лог, уведомление останется непрочитанным до ленты.
  Худший исход — лишняя единица на колокольчике, а не потерянный подарок.
- **Отметка ждёт ответа базы** (с таймаутом), а не уходит в фон: клиент
  сразу после действия перечитывает знаки (T-0211), и фоновая отметка не
  успевала бы.
- **Одна функция в сервисе** `readFor(accountId, kind, match?)`, где `match`
  — `{ key: "fromAccountId" | "itemId", values: string[] }`. Без `match` —
  все непрочитанные этого вида. Пустой `values` — ничего не делать и не
  ходить в базу.

## Как сейчас

- `backend/api/src/modules/notifications/notifications.repository.ts` —
  интерфейс `NotificationsRepository` (строки 46–71) и Prisma-реализация;
  `markRead(accountId, upTo, at)` (137–139) гасит всё не новее `upTo`.
- `backend/api/src/modules/notifications/notifications.service.ts` —
  `read(accountId, upTo)` для ленты; `post` пишет, не бросая, — образец
  обработки сбоя (`notify`, предупреждение в лог).
- `backend/api/src/modules/notifications/notification-kinds.ts` — данные
  видов: у `friend_request` и `friend_gift` — `fromAccountId`, у `rare_loot`
  — `itemId`.
- `backend/api/src/modules/friends/friends.service.ts`:
  - `view(accountId)` (91–110) — экран друзей, в нём `incoming`;
  - `claimGifts(actor)` (184–208) — забирает `gifts` (у каждого
    `fromAccountId`);
  - `accept(actor, fromId)` (237–247), `decline(actor, fromId)` (249–251).
- `backend/api/src/modules/items/items.service.ts:102–104` — `markSeen`.
- `backend/api/src/modules/changelog/changelog.service.ts:87–90` —
  `markSeen`; в конструкторе (59–64) `NotificationsService` нет, а модуль
  `NotificationsModule` уже подключён (`changelog.module.ts:15`).
- `backend/api/test/helpers/memory-notifications.ts` — уведомления в памяти
  для тестов модулей.

## Шаги по порядку

1. **Репозиторий.** В интерфейс — `markReadOf(accountId, kind, match, at):
   Promise<number>`: гасит непрочитанные строки вида `kind`, а при `match` —
   только те, у которых `payload[match.key]` — одно из `match.values`.
   Prisma — `updateMany` с фильтром JSON по пути (`payload: { path:
   [key], equals: value }` через `OR`). Возвращает число погашенных.
   Та же функция — в `MemoryNotificationsRepository`.
2. **Сервис.** `async readFor(accountId, kind, match?)` — тип `kind` —
   `NotificationKind`; таймаут — `DB_TIMEOUT_MS`; ошибка → предупреждение
   `{ module: "notifications", event: "read_by_action_failed", kind }`, не
   бросает.
3. **Друзья.**
   - `view` — после сборки ответа `readFor(accountId, "friend_request")`.
   - `accept` и `decline` — после успеха `readFor(actor.accountId,
     "friend_request", { key: "fromAccountId", values: [fromId] })`.
     `decline`, который ничего не отклонил (`declined: false`), тоже гасит:
     заявки уже нет.
   - `claimGifts` — после цикла `readFor(actor.accountId, "friend_gift",
     { key: "fromAccountId", values: <отправители забранных> })`; ничего не
     забрано — вызова нет.
4. **Предметы.** `markSeen` — после отметки `readFor(accountId,
   "rare_loot", { key: "itemId", values: itemIds })`.
5. **Журнал.** `ChangelogService` получает `NotificationsService` в
   конструктор; `markSeen` — после отметки `readFor(accountId,
   "app_update")`. Тесты, которые создают сервис, получают уведомления в
   памяти.
6. **Документы.** `docs/35-stage4-plan.md` §3.17 уже говорит о прочтении
   действием (Р135) — сверить формулировку с тем, что сделано, и поправить,
   если разошлось.

## Чего не трогаем

- Ленту, `POST /me/notifications/read` и экран ленты.
- Знак друзей и его подсчёт.
- Клиент: перечитывание знаков после действий — T-0211.
- Дубль уведомлений в бота.

## Тесты

Первым коммитом.

- `notifications.integration.test.ts` (живая база):
  - три `friend_request` от A, B и C; `markReadOf(me, "friend_request",
    { key: "fromAccountId", values: [B] })` → 1, непрочитанных 2; у A и C
    `readAt` пуст;
  - без `match` — гаснут все `friend_request`, `friend_gift` того же
    аккаунта остаётся непрочитанным;
  - уже прочитанное повторно не трогается (`readAt` прежний), число — 0;
  - чужой аккаунт не задет.
- `friends.test.ts` (уведомления в памяти):
  - `view` гасит заявки, подарок остаётся непрочитанным;
  - `accept` от B гасит заявку B, заявка C — нет;
  - `decline` гасит заявку даже при `declined: false`;
  - `claimGifts` при суточном потолке 1 и двух подарках от A и B гасит
    уведомление только того, чей подарок забран;
  - сбой `markReadOf` (репозиторий бросает) — `accept` всё равно вернул
    `{ status: "friends" }`.
- `items.integration.test.ts` — `markSeen([itemId])` гасит `rare_loot` с
  этим `itemId`, `rare_loot` другого предмета остаётся.
- `changelog.test.ts` — `markSeen` гасит `app_update`, `team_message`
  остаётся.

## Аналитика

Нет новых событий: прочитанное — поле `read_at` таблицы `notification`
(`docs/22-analytics-and-metrics.md`, строка о `notification_opened`).

## Настройки и окружение

Нет.

## Документы

`docs/35-stage4-plan.md` §3.17 — по шагу 6.

## Критерии приёмки

- [ ] Экран друзей гасит уведомления о заявках; ответ на заявку гасит
  уведомление этого игрока.
- [ ] Забор подарков гасит уведомления о забранных подарках, и только о них.
- [ ] Просмотр предмета гасит его редкую добычу; журнал — уведомления о
  версиях.
- [ ] «Бусты вернулись» и «сообщение команды» по-прежнему гаснут только
  лентой.
- [ ] Сбой отметки не ломает действие игрока.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(notifications): Уведомления гаснут своим действием`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: уведомление гаснет само, когда вы приняли заявку, забрали подарок, посмотрели предмет или открыли «Что нового»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — УВЕДОМЛЕНИЯ ГАСНУТ СВОИМ ДЕЙСТВИЕМ**

  Колокольчик больше не горит про сделанное. Заявка в друзья гаснет на экране друзей и при ответе, подарок — когда его забрали, редкая добыча — когда открыт лист предмета, выход версии — в журнале обновлений. Гасит сервер, поэтому одинаково на всех устройствах. «Бусты вернулись» и сообщение команды — по-прежнему только лентой.
  ```
