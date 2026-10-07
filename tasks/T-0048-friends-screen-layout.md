---
id: T-0048
title: Экран друзей — список первым, полоса бонуса и «Подарить всем»
epic: E12
priority: P2
status: ready
owner:
size: M
depends_on: [T-0047]
zones:
  - packages/app-shell/src/screens/meta/friends.tsx
  - packages/app-shell/src/screens/meta/friends-parts.tsx
  - packages/app-shell/src/screens/meta/friends-rules.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/test/friends-rules.test.ts
  - packages/app-shell/test/friends-api.test.ts
shared:
  - packages/app-shell/src/i18n/ru-friends.json
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/friends.html
---

# T-0048. Экран друзей — список первым, полоса бонуса и «Подарить всем»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0048.json)](README.md#значки-статуса) [![T-0047](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0047.json&label=T-0047)](T-0047-gift-all-friends-api.md)

## Зачем

На экране друзей всегда сверху крупное приглашение. У игрока, у которого
друзья есть, список и подарки уезжают вниз. Бонус за число друзей — строками в
самом низу, его не видно рядом с «Пригласить». Подарки — по одной кнопке на
друга. После задачи:

- порядок зависит от того, есть ли друзья;
- бонус — полосой шагов у приглашения;
- над списком — «Подарить всем».

## Решения

Решения пользователя от 07.10.2026, макет — `design/screens/friends.html`, четыре
состояния:

- **Порядок зависит от друзей:**
  - **друзей нет** — крупное приглашение, как сейчас: значок, заголовок,
    «Пригласить», «Копировать ссылку»; под ними полоса бонуса и три пункта;
  - **друзья есть** — сверху подарки и заявки, затем «Подарить всем» и
    список, затем приглашение компактной карточкой с полосой, затем исходящие
    заявки.
- **Бонус — полосой шагов у приглашения.** Отдельной карточки «Бонус за друзей»
  внизу больше нет.
- **«Подарить всем» — над списком** (сервер — T-0047).

Решения тимлидов:

- **Полоса — шаги равными промежутками**, а не по шкале числа друзей: до 20
  друзей первые шаги иначе слиплись бы в точку.
  - На шаге — число друзей;
  - под шагом — монеты;
  - пройденный — заливкой тона друзей и галочкой;
  - готовый к забору — акцентом со свечением.
- **Тон раздела — тон виджета друзей на главной** (`--widget-friends-tone`), как
  в макете главной.
- **Знак «Тестер» у имени — не здесь, а в T-0043:** у строки друга должно быть
  место под знак после имени, сам знак рисует T-0043.

## Как сейчас

- **`screens/meta/friends.tsx`** (391 строка):
  - `FriendsScreen` рисует по порядку `PageTitle`, `RestrictedPlaque`,
    `Invite`, `Gifts`, входящие заявки, список друзей
    (`friends.list` — «Друзья · N из M»), исходящие, `Bonus`;
  - `Invite` — `IconEmblem`, заголовок и текст, «Пригласить» (`send()` —
    `sharePreparedMessage` или `adapter.invite`), «Копировать ссылку»,
    строка состояния, карточка из трёх пунктов;
  - `Gifts` — карточка «N подарков ждут» и «Забрать»;
  - `Bonus` — шаги строками (`friends.bonus.step`), «Забрать N монет»;
  - `PeerRow` — аватар, имя, кнопки; нажатие на имя — «Удалить из друзей?».
- **`state/friends-api.ts`:**
  - `FriendsView`: `friends`, `incoming`, `outgoing`, `gifts` (`sentToday`,
    `pending`, `claimableToday`, `coins`), `bonus` (`qualified`, `steps` с
    `state`: `locked` / `ready` / `claimed`, `readyCoins`), `limits`;
  - запросы `gift`, `claimGifts`, `claimBonus` и другие — через `post(...)`.
- **Ограничения:** `giftsClosed` и `rewardsClosed` в `FriendsScreen` —
  `useRestricted`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`state/friends-api.ts`:**
   - `giftAll(): Promise<ApiResult<{ sent: number }>>` —
     `post("/gifts/send-all", z.object({ sent: z.number() }))`;
   - в `FriendsApi` — метод в интерфейсе.
3. **Новый `screens/meta/friends-rules.ts`** — чистые правила:

   ```ts
   /** Кому «Подарить всем» подарит сейчас: друзья без подарка за сутки. */
   export function giftAllCount(friendIds: readonly string[], sentToday: readonly string[]): number;

   /** Полоса бонуса: доля заливки 0..1 при шагах равными промежутками, следующий шаг и сколько до него. */
   export function bonusTrack(qualified: number, steps: readonly { friends: number }[]): { fill: number; next: number | null; left: number | null };

   /** Порядок экрана: друзей нет — крупное приглашение сверху; есть — список первым. */
   export function friendsLayout(friendsCount: number): "invite-first" | "list-first";
   ```

   **`bonusTrack`:**
   - `fill = (k + доля между шагом k и k+1) / (шагов − 1)`, где `k` — индекс
     последнего пройденного шага;
   - до первого шага `fill = 0`;
   - все пройдены → `fill = 1`, `next = null`, `left = null`.
4. **Новый `screens/meta/friends-parts.tsx`.** Перенести сюда `Invite`, `Gifts`,
   `PeerRow`, чтобы `friends.tsx` стал короче 300 строк, и добавить:
   - **`BonusTrack({ bonus, busy, closed, onClaim })`** — полоса по макету:
     - линия 6 px, кружки шагов 20 px;
     - подписи монет под шагами: первая прижата влево, последняя — вправо,
       чтобы не выходили за край;
     - строка `friends.bonus.counted` («Засчитано: {qualified} ·
       засчитывается друг, сыгравший хоть один честный забег»);
     - при `readyCoins > 0` — кнопка `friends.bonus.claim`;
     - анимируется только `transform` заливки;
   - **`Invite` с проп `variant: "full" | "card"`:**
     - `full` — как сейчас, но вместо карточки бонуса ниже кнопок —
       `BonusTrack`, затем три пункта;
     - `card` — компактная карточка в тоне друзей: значок 40 px,
       `friends.invite.more` («Позови ещё»), строка `friends.invite.next`
       («До следующей награды — {left} …» с формами числа), `BonusTrack`, две
       кнопки в ряд — «Пригласить» и `friends.invite.copyShort` («Ссылка»);
       строка состояния приглашения — под ними, как сейчас;
   - **`GiftAll({ count, busy, closed, onGift })`** — строка над списком:
     - `count > 0` — `friends.giftAll.title` («Подарить всем · {count}»),
       подпись `friends.giftAll.hint` («По {coins} монет тем, кому сегодня ещё
       не дарили»), кнопка `friends.giftAll.action` («Подарить»);
     - `count === 0` при непустом списке — `friends.giftAll.done` («Всем
       подарено») и `friends.giftAll.tomorrow` («Следующие подарки —
       завтра»);
     - `closed` — кнопка недоступна;
   - **`PeerRow`** — после имени место под знак: проп `badge?: ReactNode`, сейчас
     его никто не передаёт.
5. **`friends.tsx`:**
   - раскладка — по `friendsLayout(friends.length)` и макету;
   - **`invite-first`:** `RestrictedPlaque`, `Invite variant="full"`,
     заявки входящие и исходящие, если есть, — ниже;
   - **`list-first`:** `RestrictedPlaque`, `Gifts`, входящие заявки,
     заголовок списка, `GiftAll`, список, `Invite variant="card"`, исходящие;
   - отдельный `Bonus` удалить — его место в `BonusTrack`;
   - «Подарить всем»:
     - `act("giftAll", () => api.giftAll(), …)` — тот же помощник, что у
       остальных действий;
     - после ответа — `notice` `friends.giftAll.sent` («Подарено: {sent}»)
       и перечитать экран, как после одиночного подарка.
6. **Тексты `ru-friends.json`:**

   ```json
   "friends.invite.more": "Позови ещё",
   "friends.invite.next": "До следующей награды — {left} {left, plural, one {друг} few {друга} many {друзей} other {друга}}",
   "friends.invite.copyShort": "Ссылка",
   "friends.bonus.counted": "Засчитано: {qualified} · засчитывается друг, сыгравший хоть один честный забег",
   "friends.giftAll.title": "Подарить всем · {count}",
   "friends.giftAll.hint": "По {coins} монет тем, кому сегодня ещё не дарили",
   "friends.giftAll.action": "Подарить",
   "friends.giftAll.done": "Всем подарено",
   "friends.giftAll.tomorrow": "Следующие подарки — завтра",
   "friends.giftAll.sent": "Подарено: {sent}"
   ```

   `friends.bonus.body` и `friends.bonus.step` удалить, если поиск не находит
   их в других местах. Список — в описании PR.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер — T-0047; знак «Тестер» — T-0043.
- Приглашение: способы отправки, тексты сообщения, аналитика `share_*` — как
  сейчас, переносятся без изменений.
- Удаление друга и его подтверждение.

## Сценарий и интерфейс

По макету, 360 px:

1. **Друзей нет** — крупное приглашение, полоса бонуса с пустой заливкой,
   три пункта.
2. **Друзья есть, подарки ждут:**
   - карточка подарков первой, заявка;
   - «Подарить всем · 3», список;
   - приглашение карточкой: засчитано 4, шаги 1 и 3 получены, до
     следующего — 1 друг.
3. **Всем подарено, бонус готов** — «Всем подарено», шаг 5 горит, «Забрать
   150 монет».
4. **Подарки закрыты ограничением** — плашка сверху, «Подарить всем» и
   «Подарить» недоступны, приглашать можно.

Загрузка, ошибка и вход без аккаунта — как сейчас. Снимки на 320, 390, 768 и
1440 px снимают тимлиды при приёмке.

## Тесты

Первым коммитом.

- **`packages/app-shell/test/friends-rules.test.ts`:**
  - `giftAllCount`: 4 друга, 1 подарен → 3; все подарены → 0; пусто → 0;
  - `bonusTrack` на шагах 1, 3, 5, 10, 20:
    - `qualified 0` → `fill 0`, `next 1`, `left 1`;
    - `4` → между шагами 3 и 5 на половине: `fill = (1 + 0.5) / 4`,
      `next 5`, `left 1`;
    - `5` → `fill 0.5`, `next 10`, `left 5`;
    - `25` → `fill 1`, `next null`;
  - `friendsLayout`: 0 → `invite-first`, 1 → `list-first`.
- **`packages/app-shell/test/friends-api.test.ts`** — `giftAll`:
  - адрес `/friends/gifts/send-all`, метод `POST`;
  - разбор `{ sent }`.

## Аналитика

Нет новых событий. События приглашения (`share_offered`, `share_completed`) —
как сейчас.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md`, каталог экранов, строка
  «Друзья»:
  - порядок по наличию друзей;
  - полоса бонуса у приглашения;
  - «Подарить всем».

## Критерии приёмки

- [ ] Без друзей сверху крупное приглашение, с друзьями — подарки, заявки и
  список, приглашение — карточкой.
- [ ] Бонус за друзей — полосой шагов у приглашения, отдельной карточки внизу
  нет.
- [ ] «Подарить всем» дарит одним нажатием тем, кому сегодня не дарили, и
  показывает, сколько подарено.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Друзья — список первым и «Подарить всем»`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: На экране друзей — «Подарить всем» и полоса бонуса за приглашения; список друзей теперь наверху.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЭКРАН ДРУЗЕЙ ПО МАКЕТУ**

  Экран друзей перестроен: у кого друзья есть — сверху подарки и список, приглашение — карточкой; у кого нет — крупное приглашение, как раньше.

  👥 **Что изменилось**

  • «Подарить всем» — подарок каждому, кому сегодня не дарили, одним нажатием
  • бонус за друзей — полосой шагов рядом с «Пригласить»: видно, сколько до следующей награды
  ```
