---
id: T-0248
title: Карточка игрока — клиент: лист по тапу в рейтинге, сезоне и у друзей, «Как меня видят» в профиле
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0247, T-0238]
zones:
  - packages/app-shell/src/state/player-card-api.ts
  - packages/app-shell/src/screens/meta/player-card.tsx
  - packages/app-shell/src/screens/meta/player-card-rules.ts
  - packages/app-shell/test/player-card-rules.test.ts
  - packages/app-shell/test/player-card-api.test.ts
shared:
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/meta/friends.tsx
  - packages/app-shell/src/screens/meta/friends-parts.tsx
  - packages/app-shell/src/screens/meta/profile.tsx
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/identity-v2.html
batch: 4
---

# T-0248. Карточка игрока — клиент: лист по тапу в рейтинге, сезоне и у друзей, «Как меня видят» в профиле

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0248.json)](README.md#значки-статуса) [![T-0247](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0247.json&label=T-0247)](T-0247-player-card-server.md) [![T-0238](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0238.json&label=T-0238)](T-0238-appearance-shell.md)

## Зачем

Игрок в рейтинге — строка с именем и числом: не видно, кто он, каким
обликом играет и чем гордится. После задачи тап по игроку в рейтинге,
таблице сезона и списке друзей открывает лист-карточку:
- облик и знаки;
- уровень, мощь, место в сезоне, числа забегов, витрина;
- «В друзья».

Свою карточку игрок видит из профиля — «Как меня видят».

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р48 и поправка 24.10.2026
(карточка — в этом блоке). Макет — `design/art/mockups/identity-v2.html`,
описание — `design/art/meta-v2.md` §1.3.

Решения `claude-lead-1` от 24.10.2026:

- **Лист снизу** `player-card.tsx` — по `publicId` строки (T-0247). Сверху
  вниз:
  - **сцена:** портрет облика `card-hero-<id>.svg` на сумеречном небе; рамка и свет — тоном редкости облика. Портрет — по правилу арта зрителя (T-0238), без арта — крупный `Avatar`;
  - **под сценой:** имя, выбранный знак (`EmblemChip`, T-0236), уровень плашкой;
  - **числа:** четыре ячейки «Лучший забег», «Место в сезоне», «Забеги», «Мощь»; нет места — «—»;
  - **знаки:** первые пять (`emblems.top`) и «+N» — сколько ещё;
  - **витрина:** до трёх «любимых» и «Престиж: N»;
  - **действия:** «В друзья» (`relation: none`), «Заявка отправлена» (`outgoing`, выключена), «Принять заявку» (`incoming`), «Вы друзья» (`friend`, без кнопки); у своей карточки действий нет.
- **Где открывается:**
  - строка рейтинга (`LeaderboardRow`);
  - строка таблицы сезона;
  - строка друга;
  - «Как меня видят» в профиле — своя карточка.

  Строка без `publicId` (старый сервер) не нажимается, как сейчас.
- **Ошибки:** 404 — «Игрок не найден», 429 — «Слишком часто — попробуйте
  через минуту», нет сети — плашка связи; лист закрывается обычным жестом.
- **Без нового движения:** лист — существующий `sheet-in`.

## Как сейчас

- `screens/meta/rating.tsx` — `LeaderboardRow`; таблица сезона — там же
  (T-0111). `screens/meta/friends.tsx`, `friends-parts.tsx` — список друзей;
  `state/friends-api.ts` — заявки по `accountId`.
- `screens/meta/profile.tsx` — после T-0236 и T-0238: «Знаки · N», «Облик».
- После T-0247 в строках есть `publicId`; `GET /players/:publicId`;
  заявка в друзья — `{ publicId }`.
- После T-0236 — `EmblemChip`; после T-0238 — `appearance-art.ts`, правило
  арта зрителя и `Avatar` с головой.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`player-card-rules.ts`:**
   - `actionFor(relation)` → кнопка и её состояние;
   - `moreEmblems(held, shown)` → «+N» или ничего;
   - `statCells(card)` → четыре ячейки с «—» на пустом.
3. **`state/player-card-api.ts`** — Zod-схема ответа, `load(publicId)`,
   коды `player_not_found` и `rate_limited`; `friends-api.ts` — заявка по
   `publicId`.
4. **`player-card.tsx`** по «Решениям».
5. **Вход:** строки рейтинга, сезона и друзей открывают лист; схемы строк — с
   необязательным `publicId`; в профиле — кнопка «Как меня видят».
6. **Витрина компонентов** — карточка: своя, друга, чужая, без арта,
   ошибка.
7. **Событие** `player_card_opened` — клиентское, поле `from` (`rating`,
   `season`, `friends`, `profile`). Сначала `docs/22` §3.3 и Zod, потом
   `state/analytics.ts`.
8. **Тексты `ru.json`**, дословно:
   - вход из профиля: `"playerCard.self": "Как меня видят"`;
   - числа:
     - `"playerCard.best": "Лучший забег"`;
     - `"playerCard.place": "Место в сезоне"`;
     - `"playerCard.runs": "Забеги"`;
     - `"playerCard.power": "Мощь"`;
   - знаки и витрина: `"playerCard.moreEmblems": "+{count}"`, `"playerCard.showcase": "Витрина"`;
   - действия:
     - `"playerCard.addFriend": "В друзья"`;
     - `"playerCard.requested": "Заявка отправлена"`;
     - `"playerCard.accept": "Принять заявку"`;
     - `"playerCard.friends": "Вы друзья"`;
   - ошибки: `"playerCard.notFound": "Игрок не найден"`, `"playerCard.tooOften": "Слишком часто — попробуйте через минуту"`.
9. **`docs/27`** — «Карточка игрока» в карте экранов §6.

## Чего не трогаем

- Сервер — T-0247. «Подарить VIP» — T-0250, золотая галочка и вид VIP —
  T-0251.
- «Поделиться карточкой» — вместе с картинками бота (Р156). Жалобу — позже.

## Сценарий и интерфейс

Рейтинг → тап по третьему месту → лист: сцена с Витязем, «Гроза боссов» под
именем, «Лучший забег 12:40 · Место 3 · Забеги 214 · Мощь 1 830», пять
знаков «+7», витрина → «В друзья» → «Заявка отправлена».

Состояния: загрузка (скелет сцены и чисел), 404, 429, нет сети, гость (лист
открывается, «В друзья» нет). Проверить 320, 390, 768, ландшафт 667×375
(`tasks/README.md`, «Приёмка»): кнопка действия видна без прокрутки.

## Тесты

Первым коммитом.

- `player-card-rules.test.ts`:
  - `actionFor` для всех пяти отношений;
  - `moreEmblems(12, 5)` → «+7», `(5, 5)` → ничего;
  - `statCells` без места — «—».
- `player-card-api.test.ts`:
  - разбор полного ответа;
  - разбор ответа без необязательных блоков;
  - 404 → `player_not_found`.
- Тесты рейтинга и друзей зелёные; строка без `publicId` не нажимается.

Снимки листа на 320 и 390 — в PR.

## Аналитика

`player_card_opened` — по шагу 7.

## Настройки и окружение

Нет.

## Документы

По шагу 9.

## Критерии приёмки

- [ ] Тап по игроку в рейтинге, сезоне и у друзей открывает карточку с обликом, знаками, числами и витриной.
- [ ] «В друзья» из карточки работает; своя карточка — из профиля, без действий.
- [ ] Ошибки и нет сети — понятной строкой, лист не ломается.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Карточка игрока`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: карточка игрока — тап по имени в рейтинге или у друзей показывает облик, знаки и числа; позвать в друзья можно прямо из неё`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА ИГРОКА**

  Тап по игроку в рейтинге, сезоне и у друзей открывает карточку: облик, знак у имени, уровень, мощь, место в сезоне, забеги и витрина. Из неё можно позвать в друзья; свою карточку игрок видит из профиля — «Как меня видят».
  ```
