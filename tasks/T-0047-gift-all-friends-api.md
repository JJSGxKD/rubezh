---
id: T-0047
title: «Подарить всем» — подарок каждому другу одним запросом
epic: E6
priority: P2
status: ready
owner:
size: S
depends_on: []
zones:
  - backend/api/src/modules/friends/friends.repository.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/friends/friends.controller.ts
  - backend/api/test/helpers/memory-friends.ts
  - backend/api/test/friends.test.ts
  - backend/api/test/friends.integration.test.ts
shared:
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/friends.html
---

# T-0047. «Подарить всем» — подарок каждому другу одним запросом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0047.json)](README.md#значки-статуса)

## Зачем

Подарок другу — раз в игровые сутки, каждому своей кнопкой. У игрока с десятком
друзей это десяток нажатий каждый день. Решение пользователя от 07.10.2026 —
кнопка «Подарить всем» над списком друзей (макет `design/screens/friends.html`).
Эта задача — маршрут на сервере; кнопку делает T-0048.

## Решения

- **Одним запросом:** подарок каждому другу, кому в эти игровые сутки ещё не
  дарили. Повтор в те же сутки ничего не дарит и не ошибка — `sent: 0`.
- **Правила те же, что у одиночного подарка:**
  - ограничение `friend_gifts` закрывает и этот маршрут;
  - уникальность подарка `(от, кому, сутки)` — та же строка `friend_gift`;
  - получатель видит то же уведомление `friend_gift`.
- **Одним SQL, а не циклом:** `INSERT … SELECT` с `ON CONFLICT DO NOTHING
  RETURNING`. Две параллельные «Подарить всем» не подарят дважды — держит
  уникальный ключ.

## Как сейчас

- `friends.controller.ts:93-97` — `POST friends/:accountId/gift`:
  - лимит `FRIENDS_LIMITS.change`;
  - `friends.sendGift(account, idOf(friend))`.
- `friends.service.ts:155-165` — `sendGift`:
  - `restrictions.ensure(accountId, "friend_gifts")`;
  - проверка дружбы;
  - `friends.sendGift(from, to)`;
  - лог `friend_gift_sent`;
  - `this.notice("friend_gift", friendId, actor.accountId)`.
- `friends.repository.ts:199-205` — `sendGift` вставляет
  `friend_gift (from_account_id, to_account_id, day)` с `ON CONFLICT DO NOTHING`;
  `day` — `TODAY` (игровые сутки).
- Дружба — таблица `friendship (account_a, account_b)`, меньший id первым
  (`orderedPair`). Друзья аккаунта — `account_a = $1 OR account_b = $1`.
- Подмена репозитория — `test/helpers/memory-friends.ts`: `sendGift`,
  `giftedToday`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`friends.repository.ts`** — метод интерфейса и реализации:

   ```ts
   /** Подарить каждому другу, кому в эти сутки ещё не дарили; вернуть, кому подарено. */
   sendGiftsToAll(from: string): Promise<string[]>;
   ```

   Реализация — один запрос:

   ```sql
   INSERT INTO friend_gift (from_account_id, to_account_id, day)
   SELECT $from::uuid, CASE WHEN account_a = $from::uuid THEN account_b ELSE account_a END, ${TODAY}
   FROM friendship
   WHERE account_a = $from::uuid OR account_b = $from::uuid
   ON CONFLICT DO NOTHING
   RETURNING to_account_id
   ```

   `TODAY` — то же выражение, что в `sendGift`.
3. **`friends.service.ts`:**

   ```ts
   /** Подарить всем друзьям, кому сегодня не дарили. Повтор в те же сутки — `sent: 0`. */
   async sendGiftsToAll(actor: AccessTokenClaims): Promise<{ sent: number }>;
   ```

   - `restrictions.ensure(actor.accountId, "friend_gifts")`;
   - `recipients = await this.friends.sendGiftsToAll(actor.accountId)`;
   - на каждого — `this.notice("friend_gift", recipient, actor.accountId)`,
     как в `sendGift`. Получателей не больше `FRIENDS_RULES.maxFriends`;
   - один лог `friend_gifts_sent_all` с `accountId` и `sent`, а не по строке
     на подарок.
4. **`friends.controller.ts`** — рядом с `gifts/claim`:

   ```ts
   /** Подарить всем друзьям, кому сегодня ещё не дарили. */
   @Post("gifts/send-all")
   async giftAll(@Req() request: unknown): Promise<{ data: { sent: number } }>;
   ```

   Лимит — `FRIENDS_LIMITS.change`.
5. **`memory-friends.ts`** — `sendGiftsToAll` по тому же правилу на данных в
   памяти.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Одиночный подарок, забор подарков, их потолок и срок.
- Клиент — T-0048.

## Тесты

Первым коммитом.

- **`backend/api/test/friends.test.ts`** (на подмене):
  - три друга, одному сегодня уже подарено → `sent: 2`, уведомления —
    двоим;
  - повтор → `sent: 0`, уведомлений нет;
  - ограничение `friend_gifts` → та же ошибка, что у одиночного подарка;
  - нет друзей → `sent: 0`.
- **`backend/api/test/friends.integration.test.ts`** (живой Postgres):
  - `sendGiftsToAll` отдаёт ровно тех друзей, кому сегодня не дарили;
  - не друзьям строк нет;
  - две параллельные `Promise.all([sendGiftsToAll(a), sendGiftsToAll(a)])`
    вместе вставили по разу на друга;
  - в сумме получателей — по одному на друга.

## Аналитика

Событий продукта нет, как у одиночного подарка. Лог — `friend_gifts_sent_all`.

## Настройки и окружение

Нет.

## Документы

- `docs/35-stage4-plan.md` §3.8 (друзья) — строка: «Подарить всем — один
  запрос `POST /api/v1/friends/gifts/send-all`, те же правила, что у подарка
  одному».

## Критерии приёмки

- [ ] `POST /api/v1/friends/gifts/send-all` дарит каждому другу, кому сегодня
  не дарили, и отвечает числом. Повтор — `0`.
- [ ] Ограничение подарков закрывает и этот маршрут.
- [ ] Параллельные запросы не дарят дважды.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Подарить всем друзьям одним запросом`
- **Метка:** `release: minor`
- **Для игроков:** нет — кнопка придёт с T-0048. Раздела `## Для игроков` в
  описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДАРИТЬ ВСЕМ ДРУЗЬЯМ**

  На сервере появился «Подарить всем»: подарок каждому другу, кому сегодня ещё не дарили, одним запросом. Кнопка на экране друзей придёт следующей задачей.

  🎁 **Как устроено**

  • правила те же, что у подарка одному: раз в сутки каждому, ограничение подарков закрывает и это
  • одним запросом к базе — два нажатия подряд не подарят дважды
  ```
