---
id: T-0448
title: Друзья в рейтинге — «нет друзей» только когда их правда нет
epic: E11
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/seasons/seasons-view.service.ts
  - backend/api/src/modules/seasons/dto/seasons.dto.ts
  - backend/api/test/seasons-friends-board.test.ts
  - packages/app-shell/src/state/seasons-api.ts
  - packages/app-shell/src/screens/meta/rating-season.tsx
  - packages/app-shell/test/rating-friends.test.ts
shared:
  - packages/app-shell/src/i18n/ru-season.json
  - backend/api/test/seasons.test.ts
  - packages/app-shell/test/seasons-api.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 4
---

# T-0448. Друзья в рейтинге — «нет друзей» только когда их правда нет

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0448.json)](README.md#значки-статуса)

## Зачем

Владелец открывает «Рейтинг → Неделя → Друзья» и видит «У тебя пока нет
друзей в игре — позови…», хотя друзья у него есть. Это неправда и зовёт
приглашать тех, кто уже в друзьях. После задачи экран различает «друзей
нет» и «друзья ещё не играли на этой неделе».

## Решения

- `docs/35-stage4-plan.md`, **Р213**: ответ доски друзей несёт число
  принятых друзей `friendCount`; друзей нет — прежний текст и «Позвать
  друзей»; друзья есть, но не играли на этой неделе — «Друзья ещё не играли
  на этой неделе — позови их в забег» и кнопка «К друзьям». Строк друзьям
  без забега недели нет: место в таблице — только с забегом.

## Как сейчас

- Сервер, `backend/api/src/modules/seasons/seasons-view.service.ts`:
  - `board()` (строки ~109–160) — общий ответ доски недели, `boardViewSchema`
    (`dto/seasons.dto.ts`, строки ~107–115): `seasonKey`, `difficulty`,
    `scoring`, `total`, `entries`, `me`;
  - `friendsStanding()` (строки ~195–208): берёт принятых друзей
    `this.friends.friends(accountId, FRIENDS_RULES.maxFriends)` и счета недели
    `store.scores(boardKey, difficulty, [я, ...друзья], "full")` — в таблицу
    попадают только те, у кого есть рейтинговый забег недели.
- Клиент, `packages/app-shell/src/screens/meta/rating-season.tsx` (строка
  ~209): `noFriends = circle === "friends" && board !== null && board.entries.every((entry) => entry.isMe)` —
  верно и когда друзья есть, но не играли, и когда таблица пуста совсем
  (`every` от пустого списка — `true`). Тогда показывается
  `season.friends.empty` и кнопка `season.friends.invite`
  (`i18n/ru-season.json`, строки ~31–32).
- Клиент, `state/seasons-api.ts`, `boardSchema` (строки ~75–83) — разбор
  ответа доски.

## Шаги по порядку

1. `seasons.dto.ts`: в `boardViewSchema` — `friendCount: count.nullable().optional()`
   с комментарием: число принятых друзей, только у `scope=friends`, иначе
   поля нет.
2. `seasons-view.service.ts`: `friendsStanding` возвращает и
   `friendCount: friends.length`; `board()` кладёт его в ответ при
   `scope=friends`. Нерейтинговая сложность и «сезона нет» — поле не
   передаётся (как сейчас — пустая таблица).
3. `seasons-api.ts`: в `boardSchema` — `friendCount: z.optional(z.nullable(z.number()))`;
   старый сервер без поля разбирается.
4. `rating-season.tsx`: чистая функция
   `export function friendsNotice(board: SeasonBoard): "none" | "idle" | null` —
   `"none"`, если `friendCount === 0`, или поля нет и в таблице никого, кроме
   меня (прежнее поведение для старого сервера); `"idle"`, если
   `friendCount > 0` и в таблице никого, кроме меня; иначе `null`.
   Вместо `noFriends`:
   - `"none"` — прежний блок (`season.friends.empty`, кнопка
     `season.friends.invite`);
   - `"idle"` — тот же блок с текстом `season.friends.idle` и кнопкой
     `season.friends.open` (ведёт туда же — `props.onInvite`, экран «Друзья»);
     если в таблице есть я — моя строка остаётся над блоком.
5. `i18n/ru-season.json`:
   - `"season.friends.idle": "Друзья ещё не играли на этой неделе — позови их в забег"`;
   - `"season.friends.open": "К друзьям"`.

## Чего не трогаем

- Состав таблицы друзей (только с забегом недели), порядок, дивизионы.
- Модуль друзей (`friends/*`) — число берётся из того же запроса.
- Таблицу «Все» и «Мой дивизион».
- Переход недели на очки — T-0446.

## Сценарий и интерфейс

«Рейтинг» → «Неделя» → «Друзья»:

- друзей нет — «У тебя пока нет друзей в игре — позови, и можно будет
  соревноваться», кнопка «Позвать друзей»;
- друзья есть, никто не играл, я играл — моя строка и под ней «Друзья ещё
  не играли на этой неделе — позови их в забег», кнопка «К друзьям»;
- друзья есть, никто не играл, я тоже — только блок «Друзья ещё не играли…»;
- кто-то из друзей играл — таблица, как сейчас;
- загрузка и ошибка — как сейчас.

## Тесты

Первым коммитом. Воспроизведение — первые два кейса каждого файла: на коде
до правки они падают.

- `backend/api/test/seasons-friends-board.test.ts` (заглушки, как блок
  `SeasonsViewService` в `seasons.test.ts`):
  - у игрока два друга, ни у кого нет забега недели, у игрока есть → ответ
    `scope=friends`: `entries` — одна строка (я), `friendCount: 2`;
  - друзей нет → `friendCount: 0`;
  - друг с забегом недели → две строки, `friendCount: 1`;
  - `scope=all` → поля `friendCount` нет.
- `packages/app-shell/test/rating-friends.test.ts` — `friendsNotice`:
  - `friendCount: 2`, в таблице только я → `"idle"`;
  - `friendCount: 2`, таблица пуста → `"idle"`;
  - `friendCount: 0` → `"none"`;
  - поля нет, в таблице только я → `"none"` (старый сервер);
  - в таблице есть друг → `null`.
- `packages/app-shell/test/seasons-api.test.ts` — ответ с `friendCount` и без
  него разбирается.

## Аналитика

Нет новых событий: нажатие кнопки идёт тем же `track` (`invite_friends`;
у «К друзьям» — `track="open_friends"`, событие `ui_clicked` по Р141).

## Настройки и окружение

Нет.

## Документы

Нет: экран рейтинга в `docs/27` §6 описан без пустых состояний друзей.

## Критерии приёмки

- [ ] С друзьями, которые не играли на этой неделе, экран не пишет «нет
      друзей».
- [ ] Без друзей — прежний текст и приглашение.
- [ ] Старый сервер (без `friendCount`) — прежнее поведение.
- [ ] Тесты из раздела «Тесты» есть и зелёные.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(rating): Не писать «нет друзей», когда друзья есть`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: в рейтинге друзей больше не пишется «нет друзей», если друзья просто не играли на этой неделе`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НЕ ПИСАТЬ «НЕТ ДРУЗЕЙ», КОГДА ДРУЗЬЯ ЕСТЬ**

  Таблица друзей недели различает «друзей нет» и «друзья ещё не играли на
  этой неделе» (Р213): сервер отдаёт число друзей, экран выбирает текст.
  ```
